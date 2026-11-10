// What a linked diagram's block offers and says, without the DOM: who gets
// which actions, the "also in other docs" line, Detach a copy, the picker's
// lists, and a new diagram's block going in on its first save.

import {
  DRAWIO_LANGUAGE,
  MAX_DIAGRAM_TITLE_LENGTH,
  drawioBlockBody,
  type DiagramSummary,
  type DiagramUsage,
  type DiagramView,
} from "../../../shared/drawio.ts";
import { ApiError } from "../../api.ts";
import type { DiagramsApi } from "../../diagrams/diagramsApi.ts";

/** A diagram as a block knows it: no source, and whether this person manages it. */
export type BlockDiagram = DiagramSummary & { readonly canEdit: boolean };

/** `DiagramView` without its source, so a block never holds a megabyte of XML. */
export function blockDiagram(diagram: DiagramView | BlockDiagram): BlockDiagram {
  const { xml: _xml, ...rest } = diagram as DiagramView;
  return rest;
}

/**
 * The later of two views of one diagram: the higher version, then the newer
 * picture, then `next`. A fetch that lands after a save must not undo it.
 */
export const laterDiagram = (current: BlockDiagram, next: BlockDiagram): BlockDiagram =>
  next.version > current.version ||
  (next.version === current.version && (next.pictureVersion ?? 0) >= (current.pictureVersion ?? 0))
    ? next
    : current;

/**
 * Folds a fetched diagram, or a change this page just made to it, into what a
 * block knows. A fetched one says whether the person manages the diagram; a
 * change heard from the page (a summary) keeps what was known.
 */
export function mergeDiagram(
  current: BlockDiagram | null,
  next: DiagramSummary | DiagramView | BlockDiagram,
): BlockDiagram {
  const canEdit = "canEdit" in next ? next.canEdit : (current?.canEdit ?? false);
  const merged = blockDiagram({ ...next, canEdit });
  return current ? { ...laterDiagram(current, merged), canEdit } : merged;
}

export type BlockActionId = "edit" | "open" | "detach" | "remove";

export interface BlockAction {
  readonly id: BlockActionId;
  readonly label: string;
  /** Why the person cannot use it, in a few words; null when they can. */
  readonly disabled: string | null;
}

/**
 * The actions on a block. Someone who only reads the doc gets none. Someone who
 * edits the doc but only views the diagram sees Edit and Detach a copy greyed
 * out with the reason: both need the diagram's source.
 */
export function blockActions(input: {
  /** Whether the person can edit the doc. */
  readonly docEditable: boolean;
  /** The diagram as this person may see it; null while unknown, and when it is gone. */
  readonly diagram: { readonly canEdit: boolean } | null;
  /** Whether the page can open the Draw.io editor and file a copy (a doc page can). */
  readonly hosted: boolean;
}): ReadonlyArray<BlockAction> {
  if (!input.docEditable) return [];
  const remove: BlockAction = { id: "remove", label: "Remove", disabled: null };
  if (!input.diagram) return [remove];
  const reason = (what: string) =>
    input.diagram?.canEdit ? null : `Only the diagram's creator can ${what} it.`;
  return [
    ...(input.hosted
      ? [{ id: "edit", label: "Edit", disabled: reason("edit") } satisfies BlockAction]
      : []),
    { id: "open", label: "Open in Diagrams", disabled: null },
    ...(input.hosted
      ? [{ id: "detach", label: "Detach a copy", disabled: reason("copy") } satisfies BlockAction]
      : []),
    remove,
  ];
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** How many docs besides `docId` link the diagram, counting those the person is not on. */
export const otherDocs = (usage: DiagramUsage, docId: string): number =>
  new Set(usage.uses.filter((use) => use.docId !== docId).map((use) => use.docId)).size +
  usage.otherDocs;

/** The caption line's note on where else the diagram is linked. */
export function usageLine(usage: DiagramUsage, docId: string): string {
  const others = otherDocs(usage, docId);
  return others > 0 ? `Also in ${plural(others, "other doc")}` : "Only in this doc";
}

const COPY_SUFFIX = " (copy)";

/** "<title> (copy)", kept within the title limit. */
export const copyTitle = (title: string): string =>
  `${title.slice(0, MAX_DIAGRAM_TITLE_LENGTH - COPY_SUFFIX.length).trimEnd()}${COPY_SUFFIX}`;

/**
 * Detach a copy: a new diagram in `projectId` with the same source, named
 * "<title> (copy)". The original is not touched. The caller points its block at
 * the copy. Only someone who manages the original has its source to copy.
 */
export async function detachCopy(
  api: Pick<DiagramsApi, "get" | "create">,
  input: { readonly diagramId: string; readonly projectId: string | null },
): Promise<DiagramView> {
  const original = await api.get(input.diagramId);
  // The same answer the server gives someone who only views the diagram and tries to change it.
  if (!original.canEdit || original.xml === null) throw new ApiError(403, { error: "forbidden" });
  return api.create({
    projectId: input.projectId,
    title: copyTitle(original.title),
    xml: original.xml,
  });
}

/** The node for a block that links `diagramId`, as the editor's JSON. */
export const drawioNode = (diagramId: string, caption: string | null = null) => ({
  type: "codeBlock",
  attrs: { language: DRAWIO_LANGUAGE },
  content: [{ type: "text", text: drawioBlockBody(diagramId, caption) }],
});

/**
 * A new diagram drawn from a doc: its block goes in on the first save, once.
 * Give the result to the editor overlay's `onSaved` and `onClose`. Exit without
 * saving reports null, so no block is added (and no diagram was created).
 */
export function insertOnFirstSave(
  insert: (diagram: DiagramSummary) => void,
): (saved: DiagramSummary | null) => void {
  let done = false;
  return (saved) => {
    if (!saved || done) return;
    done = true;
    insert(saved);
  };
}

export type PickerScope = "project" | "all";

export interface PickerLists<A> {
  /** The scopes on offer, in order, with how many diagrams each holds. One scope: no switch. */
  readonly scopes: ReadonlyArray<{ readonly scope: PickerScope; readonly count: number }>;
  /** The diagrams to list for the chosen scope. */
  readonly shown: ReadonlyArray<A>;
}

/**
 * What the Draw.io diagram picker lists. It opens on the doc's project (or "no
 * project"); "All projects" lists that project's diagrams first, then the rest
 * in the order given. A frame locked to its project offers no other project.
 */
export function pickerLists<A extends { readonly projectId: string | null }>(
  diagrams: ReadonlyArray<A>,
  input: {
    /** The doc's project; null for a doc in no project. */
    readonly projectId: string | null;
    readonly scope: PickerScope;
    /** True inside a parent that keeps this frame in one project. */
    readonly locked: boolean;
  },
): PickerLists<A> {
  const own = diagrams.filter((diagram) => diagram.projectId === input.projectId);
  if (input.locked) return { scopes: [{ scope: "project", count: own.length }], shown: own };
  const rest = diagrams.filter((diagram) => diagram.projectId !== input.projectId);
  return {
    scopes: [
      { scope: "project", count: own.length },
      { scope: "all", count: diagrams.length },
    ],
    shown: input.scope === "all" ? [...own, ...rest] : own,
  };
}
