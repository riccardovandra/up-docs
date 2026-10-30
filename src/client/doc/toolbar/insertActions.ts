import type { Editor } from "@tiptap/core";
import { useSyncExternalStore } from "react";

import { findWidgetFences, widgetInfoString } from "../../../shared/widget/fence.ts";
import { insertRichTable } from "../../editor/table/tableBlock.ts";

/** What an insert action can reach besides the editor. */
export interface InsertContext {
  readonly editor: Editor;
  /** Opens the file picker and uploads the chosen image into the doc. */
  readonly pickImage: () => void;
}

/**
 * Something the toolbar can put into a tab. The toolbar's own buttons look up
 * `diagram`, `table`, `image` and `checklist` by id, so registering one of
 * those ids replaces what the button does; any action with an `order` is also
 * listed in the "+" menu, lowest first.
 */
export interface InsertAction {
  readonly id: string;
  readonly label: string;
  readonly order?: number;
  readonly run: (context: InsertContext) => void;
}

/** A small diagram in Claude's widget format; it passes `analyzeWidget`. */
export const STARTER_DIAGRAM = `export default () => {
  const edge = 'var(--cds-chart-axis)', accent = 'var(--cds-chart-categorical-1)', ink = 'var(--cds-text-primary)';
  return <svg viewBox='0 0 520 120' role='img' aria-label='An idea becomes a plan, then shipped work' fontSize='13'>
    <defs><marker id='starter-arrow' viewBox='0 0 10 10' refX='9' refY='5' markerWidth='6' markerHeight='6' orient='auto-start-reverse'><path d='M0 0L10 5L0 10z' fill={edge}/></marker></defs>
    <g data-claude-anchor='connectors' fill='none' stroke={edge} strokeWidth='1.25'>
      <path d='M164 60H196' markerEnd='url(#starter-arrow)'/>
      <path d='M324 60H356' markerEnd='url(#starter-arrow)'/>
    </g>
    <g data-claude-anchor='step-idea'><rect x='36' y='36' width='128' height='48' rx='8' fill='none' stroke={edge} strokeWidth='1.25'/><text data-claude-text-id='idea' x='100' y='64' textAnchor='middle' fill={ink}>Idea</text></g>
    <g data-claude-anchor='step-plan'><rect x='196' y='36' width='128' height='48' rx='8' fill='none' stroke={edge} strokeWidth='1.25'/><text data-claude-text-id='plan' x='260' y='64' textAnchor='middle' fill={ink}>Plan</text></g>
    <g data-claude-anchor='step-ship'><rect x='356' y='36' width='128' height='48' rx='8' fill={accent} fillOpacity='0.12' stroke={accent} strokeWidth='2'/><text data-claude-text-id='ship' x='420' y='64' textAnchor='middle' fontWeight='600' fill={ink}>Ship</text></g>
  </svg>;
};`;

/** A diagram id not yet used in `markdown`; ids must be unique within a tab. */
export function nextDiagramId(markdown: string): string {
  const taken = new Set(findWidgetFences(markdown).map((fence) => fence.id));
  for (let index = 1; ; index++) {
    const id = `diagram-${index}`;
    if (!taken.has(id)) return id;
  }
}

const block = (editor: Editor) => editor.chain().focus();

const DEFAULT_ACTIONS: ReadonlyArray<InsertAction> = [
  {
    id: "heading",
    label: "Heading",
    order: 10,
    run: ({ editor }) => block(editor).toggleHeading({ level: 2 }).run(),
  },
  {
    id: "bullet-list",
    label: "Bulleted list",
    order: 20,
    run: ({ editor }) => block(editor).toggleBulletList().run(),
  },
  {
    id: "numbered-list",
    label: "Numbered list",
    order: 21,
    run: ({ editor }) => block(editor).toggleOrderedList().run(),
  },
  {
    id: "checklist",
    label: "Checklist",
    order: 22,
    run: ({ editor }) => block(editor).toggleTaskList().run(),
  },
  {
    id: "quote",
    label: "Quote",
    order: 30,
    run: ({ editor }) => block(editor).toggleBlockquote().run(),
  },
  {
    id: "code",
    label: "Code block",
    order: 40,
    run: ({ editor }) => block(editor).toggleCodeBlock().run(),
  },
  {
    id: "divider",
    label: "Divider",
    order: 50,
    run: ({ editor }) => block(editor).setHorizontalRule().run(),
  },
  {
    id: "diagram",
    label: "Diagram",
    order: 60,
    run: ({ editor }) =>
      block(editor)
        .insertContent({
          type: "codeBlock",
          attrs: { language: widgetInfoString(nextDiagramId(editor.getMarkdown())) },
          content: [{ type: "text", text: STARTER_DIAGRAM }],
        })
        .run(),
  },
  {
    id: "table",
    label: "Table",
    order: 70,
    run: ({ editor }) => void insertRichTable(editor),
  },
  { id: "image", label: "Image", order: 80, run: ({ pickImage }) => pickImage() },
];

let actions: ReadonlyMap<string, InsertAction> = new Map(
  DEFAULT_ACTIONS.map((action) => [action.id, action]),
);
let menu: ReadonlyArray<InsertAction> = [];
const listeners = new Set<() => void>();

function changed(next: ReadonlyMap<string, InsertAction>): void {
  actions = next;
  menu = [...next.values()]
    .filter((action) => action.order !== undefined)
    .toSorted((a, b) => a.order! - b.order!);
  for (const listener of listeners) listener();
}
changed(actions);

/**
 * Adds an action, or replaces the one with the same id. Returns a function
 * that puts back whatever the id held before.
 */
export function registerInsertAction(action: InsertAction): () => void {
  const previous = actions.get(action.id);
  changed(new Map(actions).set(action.id, action));
  return () => {
    if (actions.get(action.id) !== action) return;
    const next = new Map(actions);
    if (previous) next.set(action.id, previous);
    else next.delete(action.id);
    changed(next);
  };
}

export const getInsertAction = (id: string): InsertAction | undefined => actions.get(id);

/** The "+" menu, in order. The same array until the registry changes. */
export const menuInsertActions = (): ReadonlyArray<InsertAction> => menu;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useInsertActions(): ReadonlyArray<InsertAction> {
  return useSyncExternalStore(subscribe, menuInsertActions);
}
