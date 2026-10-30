import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

export interface HeadingSection {
  /** Level, text and occurrence, so a fold survives a remote rewrite of the tab. */
  readonly key: string;
  readonly level: number;
  readonly pos: number;
  /** Position just after the heading node. */
  readonly bodyStart: number;
  /** Where the next heading of the same or a higher level starts, or the doc end. */
  readonly end: number;
}

export interface FoldedRange {
  readonly heading: number;
  readonly from: number;
  readonly to: number;
}

/** Top-level headings with the span of their sections, in reading order. */
export function headingSections(doc: ProseMirrorNode): Array<HeadingSection> {
  const sections: Array<Omit<HeadingSection, "end"> & { end: number }> = [];
  const open: Array<(typeof sections)[number]> = [];
  const seen = new Map<string, number>();
  doc.forEach((node, pos) => {
    if (node.type.name !== "heading") return;
    const level = node.attrs.level as number;
    const base = `${level}:${node.textContent.replace(/\s+/g, " ").trim()}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    while (open.length > 0 && open.at(-1)!.level >= level) open.pop()!.end = pos;
    const section = {
      key: occurrence === 0 ? base : `${base}#${occurrence}`,
      level,
      pos,
      bodyStart: pos + node.nodeSize,
      end: doc.content.size,
    };
    sections.push(section);
    open.push(section);
  });
  return sections;
}

/** The hidden spans for `folded`; a fold inside a folded section adds nothing. */
export function foldedRanges(
  sections: ReadonlyArray<HeadingSection>,
  folded: ReadonlySet<string>,
): Array<FoldedRange> {
  const ranges: Array<FoldedRange> = [];
  for (const section of sections) {
    if (!folded.has(section.key) || section.pos < (ranges.at(-1)?.to ?? 0)) continue;
    if (section.bodyStart < section.end) {
      ranges.push({ heading: section.pos, from: section.bodyStart, to: section.end });
    }
  }
  return ranges;
}

interface FoldState {
  readonly folded: ReadonlySet<string>;
  readonly ranges: ReadonlyArray<FoldedRange>;
  readonly decorations: DecorationSet;
}

type FoldMeta = { readonly toggle: string } | { readonly unfold: ReadonlyArray<string> };

const foldKey = new PluginKey<FoldState>("docsCloudHeadingFold");

const CHEVRON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function toggleButton(key: string, folded: boolean) {
  return (view: EditorView) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "fold-toggle";
    button.contentEditable = "false";
    button.setAttribute("aria-expanded", String(!folded));
    button.setAttribute("aria-label", folded ? "Expand section" : "Collapse section");
    button.innerHTML = CHEVRON;
    // Keeps the caret and focus where they are.
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => view.dispatch(toggleFold(view.state, key)));
    return button;
  };
}

function buildState(doc: ProseMirrorNode, folded: ReadonlySet<string>): FoldState {
  const sections = headingSections(doc);
  const ranges = foldedRanges(sections, folded);
  const decorations: Array<Decoration> = [];
  for (const section of sections) {
    if (ranges.some((range) => section.pos >= range.from && section.pos < range.to)) continue;
    const isFolded = folded.has(section.key);
    decorations.push(
      Decoration.widget(section.pos + 1, toggleButton(section.key, isFolded), {
        side: -1,
        key: `fold:${isFolded ? "closed" : "open"}:${section.key}`,
        ignoreSelection: true,
        stopEvent: () => true,
      }),
    );
  }
  for (const range of ranges) {
    doc.nodesBetween(range.from, range.to, (node, pos) => {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "fold-hidden" }));
      return false;
    });
  }
  return { folded, ranges, decorations: DecorationSet.create(doc, decorations) };
}

/**
 * Carries folds across an edit: a heading follows its mapped position, so
 * retyping a folded heading keeps it folded; after a whole-doc replace the
 * key matches instead.
 */
function carryFolds(
  folded: ReadonlySet<string>,
  before: ProseMirrorNode,
  after: ProseMirrorNode,
  map: (pos: number) => { readonly pos: number; readonly deleted: boolean },
): ReadonlySet<string> {
  if (folded.size === 0) return folded;
  const sections = headingSections(after);
  const keyAt = new Map(sections.map((section) => [section.pos, section.key]));
  const keys = new Set(sections.map((section) => section.key));
  const next = new Set<string>();
  for (const section of headingSections(before)) {
    if (!folded.has(section.key)) continue;
    const mapped = map(section.pos);
    const key = mapped.deleted ? undefined : keyAt.get(mapped.pos);
    if (key) next.add(key);
    else if (keys.has(section.key)) next.add(section.key);
  }
  return next;
}

function applyMeta(folded: ReadonlySet<string>, meta: FoldMeta): ReadonlySet<string> {
  const next = new Set(folded);
  if ("toggle" in meta) {
    if (!next.delete(meta.toggle)) next.add(meta.toggle);
  } else {
    for (const key of meta.unfold) next.delete(key);
  }
  return next;
}

export const foldPlugin = () =>
  new Plugin<FoldState>({
    key: foldKey,
    state: {
      init: (_, state) => buildState(state.doc, new Set()),
      apply: (tr, previous, before) => {
        const meta = tr.getMeta(foldKey) as FoldMeta | undefined;
        if (!tr.docChanged && !meta) return previous;
        let folded = tr.docChanged
          ? carryFolds(previous.folded, before.doc, tr.doc, (pos) => tr.mapping.mapResult(pos, 1))
          : previous.folded;
        if (meta) folded = applyMeta(folded, meta);
        return buildState(tr.doc, folded);
      },
    },
    props: { decorations: (state) => foldKey.getState(state)?.decorations },
  });

/** Folds and unfolds sections from a chevron beside each heading. View-only: the markdown never changes. */
export const HeadingFold = Extension.create({
  name: "headingFold",
  addProseMirrorPlugins: () => [foldPlugin()],
});

/** Folds or unfolds the section under `key`, moving a caret the fold would hide onto its heading. */
export function toggleFold(state: EditorState, key: string): Transaction {
  const tr = state.tr.setMeta(foldKey, { toggle: key } satisfies FoldMeta);
  const section = headingSections(state.doc).find((candidate) => candidate.key === key);
  const { from, to } = tr.selection;
  if (section && !foldedKeys(state).has(key) && to > section.bodyStart && from < section.end) {
    tr.setSelection(TextSelection.create(tr.doc, section.bodyStart - 1));
  }
  return tr;
}

export function foldedKeys(state: EditorState): ReadonlySet<string> {
  return foldKey.getState(state)?.folded ?? new Set();
}

/** Where `pos` shows on screen: the folded heading that hides it, or `pos` itself. */
export function visiblePos(state: EditorState, pos: number): number {
  const range = foldKey.getState(state)?.ranges.find((r) => pos >= r.from && pos < r.to);
  return range ? range.heading : pos;
}

/** Unfolds every section hiding `pos`. */
export function revealPos(view: EditorView, pos: number) {
  const folded = foldedKeys(view.state);
  if (folded.size === 0) return;
  const unfold = headingSections(view.state.doc)
    .filter((section) => folded.has(section.key))
    .filter((section) => pos >= section.bodyStart && pos < section.end)
    .map((section) => section.key);
  if (unfold.length > 0)
    view.dispatch(view.state.tr.setMeta(foldKey, { unfold } satisfies FoldMeta));
}
