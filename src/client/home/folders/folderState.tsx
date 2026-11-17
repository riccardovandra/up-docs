// Folders on the home page, shared by the Docs, Diagrams and Sheets views: the
// project's folder tree, the folder being shown, and the per-device layout
// settings (folder sidebar shown or hidden, cards per row). The library page
// provides it; each view registers the items it holds so counts follow the kind.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from "react";

import {
  childFolders,
  folderAndDescendants,
  type Folder,
  type FolderItemKind,
  type ProjectFolders,
} from "../../../shared/folders.ts";
import { request } from "../../api.ts";

/** A card or row the views hand to the folder state: enough to count and preview. */
export interface FolderItem {
  readonly id: string;
  readonly title: string;
}

/** Cards per row: "auto" fits the width; a number fixes it. Phones offer 1 or 2. */
export type CardsPerRow = "auto" | "1" | "2" | "3" | "4" | "5" | "6";
export const DESKTOP_CARDS_PER_ROW: ReadonlyArray<CardsPerRow> = ["auto", "2", "3", "4", "5", "6"];
export const PHONE_CARDS_PER_ROW: ReadonlyArray<CardsPerRow> = ["1", "2"];

const SIDEBAR_KEY = "up-docs.home.folder-sidebar";
const COLS_KEY = "up-docs.home.cards-per-row";
const PHONE_COLS_KEY = "up-docs.home.cards-per-row.phone";
const folderKey = (projectId: string) => `up-docs.home.folder.${projectId}`;
/** A drag carrying a library item: `kind:id`. */
const DRAG_TYPE = "application/x-up-docs-item";
/** Phones and narrow windows: the sidebar gives way to a folder bar and a picker. */
const NARROW_QUERY = "(max-width: 640px)";

function read(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function write(storage: () => Storage, key: string, value: string | null): void {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch {
    // Remembering is a convenience.
  }
}

const local = () => window.localStorage;
const session = () => window.sessionStorage;

const isCardsPerRow = (value: string | null, options: ReadonlyArray<CardsPerRow>) =>
  value !== null && (options as ReadonlyArray<string>).includes(value);

function subscribeNarrow(change: () => void): () => void {
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
}

/** Whether the page is phone-narrow; the folder sidebar never shows there. */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}

/** What the folder picker is doing: jumping to a folder, or filing one item. */
export type PickerState =
  | { readonly mode: "go" }
  | { readonly mode: "move"; readonly kind: FolderItemKind; readonly id: string; readonly title: string };

export interface FolderState {
  /** Folders apply: a single project is in scope. */
  readonly active: boolean;
  /** Only the admin makes, renames, deletes folders and files items. */
  readonly canManage: boolean;
  readonly projectName: string;
  readonly folders: ReadonlyArray<Folder>;
  /** The folder shown, or null for every item of the kind. */
  readonly at: Folder | null;
  readonly go: (folderId: string | null) => void;
  readonly narrow: boolean;
  /** The user's setting; the sidebar shows only when also active and not narrow. */
  readonly sidebarOpen: boolean;
  readonly sidebarShown: boolean;
  readonly toggleSidebar: () => void;
  readonly cardsPerRow: CardsPerRow;
  readonly setCardsPerRow: (value: CardsPerRow) => void;
  /** Subfolders of the folder shown, by name. */
  readonly subfolders: ReadonlyArray<Folder>;
  readonly folderOf: (kind: FolderItemKind, id: string) => Folder | null;
  /** Items of `kind` in `folderId` and below, among those the view registered. */
  readonly countIn: (kind: FolderItemKind, folderId: string | null) => number;
  /** The first few titles in a folder and below, for a folder card's preview. */
  readonly titlesIn: (kind: FolderItemKind, folderId: string) => ReadonlyArray<string>;
  /** Whether an item belongs in the view: in the folder shown, or anywhere at the top. */
  readonly shows: (kind: FolderItemKind, id: string) => boolean;
  /** Items in the folder shown; every item at the top. */
  readonly filter: <A extends FolderItem>(kind: FolderItemKind, items: ReadonlyArray<A>) => ReadonlyArray<A>;
  readonly register: (kind: FolderItemKind, items: ReadonlyArray<FolderItem>) => void;
  readonly createFolder: (parentId: string | null, name: string) => Promise<Folder | null>;
  readonly renameFolder: (folderId: string, name: string) => Promise<void>;
  readonly deleteFolder: (folderId: string) => Promise<void>;
  readonly place: (kind: FolderItemKind, id: string, folderId: string | null) => Promise<void>;
  readonly picker: PickerState | null;
  readonly openPicker: (state: PickerState) => void;
  readonly closePicker: () => void;
  /** Props that make a card or row draggable onto a folder (nothing when filing is off). */
  readonly dragProps: (kind: FolderItemKind, id: string) => {
    readonly draggable?: boolean;
    readonly onDragStart?: (event: DragEvent) => void;
  };
  /** Props that make an element a drop target for `folderId` (null: out of every folder). */
  readonly dropProps: (folderId: string | null) => {
    readonly onDragOver?: (event: DragEvent) => void;
    readonly onDragLeave?: () => void;
    readonly onDrop?: (event: DragEvent) => void;
    readonly "data-drop-over"?: boolean;
  };
  /** The grid's class and inline columns for the cards-per-row setting. */
  readonly grid: { readonly className: string; readonly style: CSSProperties | undefined };
}

const FolderContext = createContext<FolderState | null>(null);

export function useFolders(): FolderState {
  const state = useContext(FolderContext);
  if (!state) throw new Error("useFolders outside FolderProvider");
  return state;
}

/** The folder state, or null outside the library (a card shown elsewhere). */
export const useOptionalFolders = (): FolderState | null => useContext(FolderContext);

/** Hands the render function the folder state; for pages that build their body inline. */
export function WithFolders(props: { readonly children: (folders: FolderState) => ReactNode }) {
  return props.children(useFolders());
}

/** Registers a kind's items from inside JSX. */
export function RegisterFolderItems(props: {
  readonly kind: FolderItemKind;
  readonly items: ReadonlyArray<FolderItem>;
}) {
  useFolderItems(props.kind, props.items);
  return null;
}

/** Registers a view's items, so the tree's counts and folder cards follow this kind. */
export function useFolderItems(kind: FolderItemKind, items: ReadonlyArray<FolderItem>): void {
  const { register } = useFolders();
  useEffect(() => register(kind, items), [register, kind, items]);
}

const placementKey = (kind: FolderItemKind, id: string) => `${kind}:${id}`;

export function FolderProvider(props: {
  /** The project in scope, or null when all projects or no project shows. */
  readonly projectId: string | null;
  readonly projectName: string;
  readonly admin: boolean;
  readonly children: ReactNode;
}) {
  const { projectId, admin } = props;
  const narrow = useNarrow();
  const [data, setData] = useState<{ readonly projectId: string; readonly value: ProjectFolders } | null>(null);
  const [atId, setAtId] = useState<string | null>(() =>
    projectId === null ? null : read(session, folderKey(projectId)),
  );
  const [atProject, setAtProject] = useState(projectId);
  const [sidebarOpen, setSidebarOpen] = useState(() => read(local, SIDEBAR_KEY) !== "hidden");
  const [desktopCols, setDesktopCols] = useState<CardsPerRow>(() => {
    const stored = read(local, COLS_KEY);
    return isCardsPerRow(stored, DESKTOP_CARDS_PER_ROW) ? (stored as CardsPerRow) : "auto";
  });
  const [phoneCols, setPhoneCols] = useState<CardsPerRow>(() => {
    const stored = read(local, PHONE_COLS_KEY);
    return isCardsPerRow(stored, PHONE_CARDS_PER_ROW) ? (stored as CardsPerRow) : "1";
  });
  const [items, setItems] = useState<Readonly<Partial<Record<FolderItemKind, ReadonlyArray<FolderItem>>>>>({});
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [dropOver, setDropOver] = useState<string | null>(null);

  // A new project in scope starts where it was last left in this tab.
  if (atProject !== projectId) {
    setAtProject(projectId);
    setAtId(projectId === null ? null : read(session, folderKey(projectId)));
  }

  const load = useCallback(async () => {
    if (projectId === null) return;
    try {
      const value = await request<ProjectFolders>(
        "GET",
        `/api/folders?projectId=${encodeURIComponent(projectId)}`,
      );
      setData({ projectId, value });
    } catch {
      // No folders (an older server, or the project is gone): the views work without them.
      setData({ projectId, value: { folders: [], placements: [] } });
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const value = data !== null && data.projectId === projectId ? data.value : null;
  const active = projectId !== null && value !== null;
  const folders = useMemo(() => value?.folders ?? [], [value]);
  const byId = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders]);
  const placements = useMemo(
    () => new Map((value?.placements ?? []).map((p) => [placementKey(p.kind, p.id), p.folderId])),
    [value],
  );
  const at = active && atId !== null ? (byId.get(atId) ?? null) : null;

  const go = useCallback(
    (folderId: string | null) => {
      setAtId(folderId);
      if (projectId !== null) write(session, folderKey(projectId), folderId);
    },
    [projectId],
  );

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => {
      write(local, SIDEBAR_KEY, open ? "hidden" : null);
      return !open;
    });
  }, []);

  const sidebarShown = active && !narrow && sidebarOpen;

  // "[" shows or hides the sidebar, outside text fields.
  useEffect(() => {
    if (!active || narrow) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "[" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable], dialog")) return;
      event.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, narrow, toggleSidebar]);

  const cardsPerRow = narrow ? phoneCols : desktopCols;
  const setCardsPerRow = useCallback(
    (next: CardsPerRow) => {
      if (narrow) {
        setPhoneCols(next);
        write(local, PHONE_COLS_KEY, next === "1" ? null : next);
      } else {
        setDesktopCols(next);
        write(local, COLS_KEY, next === "auto" ? null : next);
      }
    },
    [narrow],
  );

  const register = useCallback((kind: FolderItemKind, list: ReadonlyArray<FolderItem>) => {
    setItems((current) => (current[kind] === list ? current : { ...current, [kind]: list }));
  }, []);

  const folderIdOf = useCallback(
    (kind: FolderItemKind, id: string): string | null => {
      const folderId = placements.get(placementKey(kind, id));
      // An item filed in a folder this person cannot see sits at the top for them.
      return folderId !== undefined && byId.has(folderId) ? folderId : null;
    },
    [placements, byId],
  );

  const itemsUnder = useCallback(
    (kind: FolderItemKind, folderId: string | null): ReadonlyArray<FolderItem> => {
      const list = items[kind] ?? [];
      if (folderId === null) return list;
      const ids = folderAndDescendants(folders, folderId);
      return list.filter((item) => {
        const placed = folderIdOf(kind, item.id);
        return placed !== null && ids.has(placed);
      });
    },
    [items, folders, folderIdOf],
  );

  const mutate = useCallback(
    async <A,>(method: string, path: string, body?: unknown): Promise<A | null> => {
      try {
        return await request<A>(method, path, body);
      } catch {
        return null;
      } finally {
        await load();
      }
    },
    [load],
  );

  const place = useCallback(
    async (kind: FolderItemKind, id: string, folderId: string | null) => {
      // Shown at once; the reload confirms it (or puts it back on failure).
      setData((current) => {
        if (current === null) return current;
        const rest = current.value.placements.filter((p) => !(p.kind === kind && p.id === id));
        return {
          ...current,
          value: {
            ...current.value,
            placements: folderId === null ? rest : [...rest, { kind, id, folderId }],
          },
        };
      });
      await mutate("POST", "/api/folders/place", { kind, id, folderId });
    },
    [mutate],
  );

  const canManage = active && admin;

  const state = useMemo((): FolderState => {
    const dragProps: FolderState["dragProps"] = (kind, id) =>
      canManage
        ? {
            draggable: true,
            onDragStart: (event) => {
              event.dataTransfer.setData(DRAG_TYPE, placementKey(kind, id));
              event.dataTransfer.effectAllowed = "move";
            },
          }
        : {};
    const dropKey = (folderId: string | null) => folderId ?? "\u0000top";
    const dropProps: FolderState["dropProps"] = (folderId) =>
      canManage
        ? {
            onDragOver: (event) => {
              if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDropOver(dropKey(folderId));
            },
            onDragLeave: () => setDropOver(null),
            onDrop: (event) => {
              const carried = event.dataTransfer.getData(DRAG_TYPE);
              setDropOver(null);
              const split = carried.indexOf(":");
              if (split < 0) return;
              event.preventDefault();
              const kind = carried.slice(0, split) as FolderItemKind;
              const id = carried.slice(split + 1);
              if (folderIdOf(kind, id) !== folderId) void place(kind, id, folderId);
            },
            "data-drop-over": dropOver === dropKey(folderId),
          }
        : {};
    const columns = cardsPerRow === "auto" ? null : Number(cardsPerRow);
    const gridClass = [
      "doc-grid",
      columns !== null && !narrow && columns >= 4 ? "doc-grid-dense" : "",
      columns !== null && narrow && columns >= 2 ? "doc-grid-phone-pair" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return {
      active,
      canManage,
      projectName: props.projectName,
      folders,
      at,
      go,
      narrow,
      sidebarOpen,
      sidebarShown,
      toggleSidebar,
      cardsPerRow,
      setCardsPerRow,
      subfolders: active ? childFolders(folders, at?.id ?? null) : [],
      folderOf: (kind, id) => {
        const folderId = folderIdOf(kind, id);
        return folderId === null ? null : (byId.get(folderId) ?? null);
      },
      countIn: (kind, folderId) => itemsUnder(kind, folderId).length,
      titlesIn: (kind, folderId) => itemsUnder(kind, folderId).slice(0, 3).map((item) => item.title),
      shows: (kind, id) => !active || at === null || folderIdOf(kind, id) === at.id,
      filter: (kind, list) =>
        !active || at === null ? list : list.filter((item) => folderIdOf(kind, item.id) === at.id),
      register,
      createFolder: async (parentId, name) => {
        if (projectId === null) return null;
        const created = await mutate<{ folder: Folder }>("POST", "/api/folders", {
          projectId,
          parentId,
          name,
        });
        return created?.folder ?? null;
      },
      renameFolder: async (folderId, name) => {
        await mutate("PATCH", `/api/folders/${folderId}`, { name });
      },
      deleteFolder: async (folderId) => {
        const folder = byId.get(folderId);
        await mutate("DELETE", `/api/folders/${folderId}`);
        if (at !== null && folderAndDescendants(folders, folderId).has(at.id)) {
          go(folder?.parentId ?? null);
        }
      },
      place,
      picker,
      openPicker: setPicker,
      closePicker: () => setPicker(null),
      dragProps,
      dropProps,
      grid: {
        className: gridClass,
        style: columns === null ? undefined : { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` },
      },
    };
  }, [
    active,
    canManage,
    props.projectName,
    folders,
    at,
    go,
    narrow,
    sidebarOpen,
    sidebarShown,
    toggleSidebar,
    cardsPerRow,
    setCardsPerRow,
    folderIdOf,
    byId,
    itemsUnder,
    register,
    projectId,
    mutate,
    place,
    picker,
    dropOver,
  ]);

  return <FolderContext.Provider value={state}>{props.children}</FolderContext.Provider>;
}
