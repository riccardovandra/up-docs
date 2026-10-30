import type { Editor, NodeViewRendererProps } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Decoration, NodeView } from "@tiptap/pm/view";

import type { StructuredAnchor } from "../../../shared/anchors.ts";
import {
  CHIP_COLORS,
  changeColumnType,
  cellText,
  COLUMN_TYPES,
  formatTable,
  isSafeUrl,
  parseTable,
  starterTable,
  TABLE_LANGUAGE,
  type CellValue,
  type ChipColor,
  type ColumnType,
  type RichTable,
  type TableColumn,
} from "../../../shared/table.ts";
import {
  addOption,
  deleteColumn,
  deleteRow,
  editOption,
  insertColumn,
  insertRow,
  removeOption,
  setCell,
  updateColumn,
} from "./tableOps.ts";
import "./table.css";

export type CellAnchor = Extract<StructuredAnchor, { kind: "cell" }>;

/**
 * What the comments plugin hands a table through a node decoration: the cell
 * threads to highlight and how to open or start one. The view keeps no
 * comment state of its own.
 */
export interface TableCommentSpec {
  readonly cells: ReadonlyArray<CellAnchor & { readonly id: string }>;
  readonly activeId: string | null;
  readonly onActivate: (id: string | null) => void;
  readonly onComment: (anchor: CellAnchor, text: string) => void;
}

export const TABLE_COMMENTS_SPEC = "t3TableComments";

export const isTableNode = (node: ProseMirrorNode) =>
  node.type.name === "codeBlock" && node.attrs.language === TABLE_LANGUAGE;

const COLUMN_TYPE_LABEL: Record<ColumnType, string> = {
  text: "Text",
  select: "Status",
  link: "Link",
  number: "Number",
  date: "Date",
};

const cellKey = (rowId: string, columnId: string) => `${rowId}\u0000${columnId}`;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string, onClick: () => void, label?: string) {
  const node = element("button", className, text);
  node.type = "button";
  if (label) node.setAttribute("aria-label", label);
  node.addEventListener("click", (event) => {
    event.preventDefault();
    onClick();
  });
  return node;
}

// Prose columns get a readable floor so a narrow page scrolls the table instead of stacking their text into tall rows.
const hasLongText = (table: RichTable, column: TableColumn) =>
  (column.type === "text" || column.type === "link") &&
  table.rows.some((row) => cellText(row.cells[column.id]).length > 40);

function chip(value: string, color: ChipColor | undefined) {
  const node = element("span", "t3-chip", value);
  node.dataset.color = color ?? "gray";
  return node;
}

const formatDate = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
};

interface EditingCell {
  readonly rowId: string;
  readonly columnId: string;
  /** Applies the editor's value; returns false when it was invalid and nothing changed. */
  readonly read: () => CellValue | undefined;
}

/**
 * A ```t3-table block. The fence's JSON is the node's text; edits write back as
 * one transaction replacing it, so saves take the normal markdown path. Typing
 * happens in plain inputs and only a committed cell dispatches and repaints, so
 * a large table is not re-rendered per keystroke.
 */
export class TableView implements NodeView {
  readonly dom = element("div", "t3-table");
  private readonly scroll = element("div", "t3-table-scroll");
  private readonly commentButton: HTMLButtonElement;
  private readonly editor: Editor;
  private readonly getPos: NodeViewRendererProps["getPos"];
  private node: ProseMirrorNode;
  private source: string | null = null;
  private table: RichTable | null = null;
  private cells = new Map<string, HTMLTableCellElement>();
  private editing: EditingCell | null = null;
  private popover: { readonly node: HTMLElement; readonly close: () => void } | null = null;
  private comments: TableCommentSpec | null = null;
  private hovered: HTMLTableCellElement | null = null;
  // Wide tables scroll inside the doc column; the fade shows hidden columns
  // where overlay scrollbars (macOS) would otherwise leave no hint of them.
  private readonly resize = new ResizeObserver(() => this.markOverflow());

  constructor({ node, editor, getPos, decorations }: NodeViewRendererProps) {
    this.node = node;
    this.editor = editor;
    this.getPos = getPos;
    this.dom.contentEditable = "false";
    this.commentButton = button(
      "t3-cell-comment",
      "Comment",
      () => this.commentOn(this.hovered),
      "Comment on cell",
    );
    this.commentButton.hidden = true;
    this.dom.append(this.scroll, this.commentButton);
    this.scroll.addEventListener("click", this.onClick);
    this.scroll.addEventListener("mouseover", this.onHover);
    this.dom.addEventListener("mouseleave", () => this.showCommentButton(null));
    this.scroll.addEventListener("scroll", () => {
      this.closePopover();
      this.showCommentButton(this.editingCell() ?? null);
      this.markOverflow();
    });
    this.comments = commentSpec(decorations);
    this.render(node.textContent);
  }

  update(node: ProseMirrorNode, decorations: ReadonlyArray<Decoration>) {
    if (!isTableNode(node)) return false;
    this.node = node;
    this.comments = commentSpec(decorations);
    if (node.textContent !== this.source) this.render(node.textContent);
    else this.paintComments();
    return true;
  }

  stopEvent() {
    return true;
  }

  ignoreMutation() {
    return true;
  }

  selectNode() {
    this.dom.classList.add("selected");
  }

  deselectNode() {
    this.dom.classList.remove("selected");
  }

  destroy() {
    this.closePopover();
    this.resize.disconnect();
  }

  private get editable() {
    return this.editor.isEditable;
  }

  /** Writes a new table into the fence. The view is already showing it. */
  private commit(table: RichTable) {
    const pos = this.getPos();
    if (typeof pos !== "number") return;
    const text = formatTable(table);
    this.table = table;
    this.source = text;
    const { state } = this.editor;
    this.editor.view.dispatch(
      state.tr.replaceWith(pos + 1, pos + 1 + this.node.content.size, state.schema.text(text)),
    );
  }

  private commitAndRender(table: RichTable) {
    this.commit(table);
    this.renderTable(table);
  }

  private render(source: string) {
    this.source = source;
    this.closePopover();
    if (source.trim() === "") {
      this.table = null;
      this.renderEmpty();
      return;
    }
    const parsed = parseTable(source);
    if (!parsed.ok) {
      this.table = null;
      this.renderError(source, parsed.error);
      return;
    }
    this.table = parsed.table;
    this.renderTable(parsed.table);
  }

  private markOverflow() {
    const { scrollLeft, scrollWidth, clientWidth } = this.scroll;
    this.dom.classList.toggle("overflow-right", scrollLeft + clientWidth < scrollWidth - 1);
  }

  private renderEmpty() {
    this.cells.clear();
    this.editing = null;
    const box = element("div", "t3-table-message", "Empty table.");
    if (this.editable) {
      box.append(
        button("button small", "Create table", () => this.commitAndRender(starterTable())),
      );
    }
    this.scroll.replaceChildren(box);
  }

  /** Invalid JSON stays visible and fixable in place, never silently dropped. */
  private renderError(source: string, message: string) {
    this.cells.clear();
    this.editing = null;
    const box = element("div", "t3-table-message error");
    box.append(element("p", "", message));
    const area = element("textarea", "t3-table-source");
    area.value = source;
    area.rows = Math.min(16, source.split("\n").length + 1);
    area.readOnly = !this.editable;
    box.append(area);
    if (this.editable) {
      const status = element("p", "muted");
      box.append(
        button("button small", "Apply", () => {
          const parsed = parseTable(area.value);
          if (!parsed.ok) {
            status.textContent = parsed.error;
            return;
          }
          this.commitAndRender(parsed.table);
        }),
        status,
      );
    }
    this.scroll.replaceChildren(box);
  }

  private renderTable(table: RichTable) {
    const keep = this.editing;
    this.editing = null;
    this.cells.clear();
    const tableNode = element("table");
    tableNode.dataset.tableId = table.id;

    const head = element("thead");
    const headRow = element("tr");
    headRow.append(element("th", "t3-row-handle"));
    for (const column of table.columns) {
      const th = element("th");
      th.dataset.colId = column.id;
      th.dataset.type = column.type;
      if (hasLongText(table, column)) th.classList.add("t3-long");
      const name = element("span", "t3-col-name", column.name || " ");
      th.append(name);
      if (this.editable) {
        th.classList.add("editable");
        th.tabIndex = 0;
      }
      headRow.append(th);
    }
    if (this.editable) {
      const add = element("th", "t3-col-add");
      add.append(
        button(
          "t3-icon-button",
          "+",
          () => {
            const next = insertColumn(table, table.columns.length);
            this.commitAndRender(next.table);
          },
          "Add column",
        ),
      );
      headRow.append(add);
    }
    head.append(headRow);

    const body = element("tbody");
    for (const row of table.rows) {
      const tr = element("tr");
      tr.dataset.rowId = row.id;
      const handle = element("td", "t3-row-handle");
      if (this.editable) {
        handle.append(button("t3-icon-button", "⋮", () => this.openRowMenu(row.id, handle), "Row"));
      }
      tr.append(handle);
      for (const column of table.columns) {
        const td = element("td");
        td.dataset.rowId = row.id;
        td.dataset.colId = column.id;
        td.dataset.type = column.type;
        this.paintCell(td, column, row.cells[column.id]);
        this.cells.set(cellKey(row.id, column.id), td);
        tr.append(td);
      }
      if (this.editable) tr.append(element("td", "t3-col-add"));
      body.append(tr);
    }
    tableNode.append(head, body);

    const nodes: Array<HTMLElement> = [tableNode];
    if (this.editable) {
      nodes.push(
        button("t3-row-add", "+ New row", () => {
          const next = insertRow(table, table.rows.length);
          this.commitAndRender(next.table);
          this.startEditing(next.rowId, table.columns[0]!.id);
        }),
      );
    }
    this.scroll.replaceChildren(...nodes);
    this.resize.disconnect();
    this.resize.observe(this.scroll);
    this.resize.observe(tableNode);
    this.paintComments();
    if (keep && this.cells.has(cellKey(keep.rowId, keep.columnId))) {
      this.startEditing(keep.rowId, keep.columnId, keep.read());
    }
  }

  private paintCell(td: HTMLTableCellElement, column: TableColumn, value: CellValue | undefined) {
    td.replaceChildren();
    if (value === null || value === undefined || cellText(value) === "") return;
    if (column.type === "select" && typeof value === "string") {
      td.append(chip(value, column.options?.find((option) => option.value === value)?.color));
    } else if (column.type === "link" && typeof value === "object") {
      if (value.url && isSafeUrl(value.url)) {
        const link = element("a", "", value.text || value.url);
        link.href = value.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        td.append(link);
      } else {
        td.textContent = value.text;
      }
    } else if (column.type === "number" && typeof value === "number") {
      td.textContent = value.toLocaleString();
    } else if (column.type === "date" && typeof value === "string") {
      td.textContent = formatDate(value);
    } else {
      td.textContent = cellText(value);
    }
  }

  private paintComments() {
    for (const td of this.scroll.querySelectorAll("td.has-comment")) {
      td.classList.remove("has-comment", "comment-active");
    }
    if (!this.table || !this.comments) return;
    for (const cell of this.comments.cells) {
      if (cell.blockId !== this.table.id) continue;
      const td = this.cells.get(cellKey(cell.rowId, cell.colId));
      if (!td) continue;
      td.classList.add("has-comment");
      if (cell.id === this.comments.activeId) td.classList.add("comment-active");
    }
  }

  private commentsOn(td: HTMLTableCellElement) {
    const table = this.table;
    if (!table || !this.comments) return [];
    return this.comments.cells.filter(
      (cell) =>
        cell.blockId === table.id &&
        cell.rowId === td.dataset.rowId &&
        cell.colId === td.dataset.colId,
    );
  }

  private commentOn(td: HTMLTableCellElement | null) {
    const table = this.table;
    if (!td || !table || !this.comments || !td.dataset.rowId || !td.dataset.colId) return;
    const row = table.rows.find((candidate) => candidate.id === td.dataset.rowId);
    this.comments.onComment(
      { kind: "cell", blockId: table.id, rowId: td.dataset.rowId, colId: td.dataset.colId },
      cellText(row?.cells[td.dataset.colId]),
    );
  }

  private showCommentButton(td: HTMLTableCellElement | null) {
    this.hovered = td;
    if (!td || !this.comments || !td.isConnected) {
      this.commentButton.hidden = true;
      return;
    }
    const box = this.dom.getBoundingClientRect();
    const rect = td.getBoundingClientRect();
    const scroller = this.scroll.getBoundingClientRect();
    if (rect.right > scroller.right + 1 || rect.right < scroller.left) {
      this.commentButton.hidden = true;
      return;
    }
    this.commentButton.hidden = false;
    this.commentButton.style.top = `${rect.top - box.top + 2}px`;
    this.commentButton.style.left = `${rect.right - box.left - 2}px`;
  }

  private readonly onHover = (event: MouseEvent) => {
    const td = (event.target as Element).closest?.("td[data-col-id]");
    if (td instanceof HTMLTableCellElement) this.showCommentButton(td);
  };

  private readonly onClick = (event: MouseEvent) => {
    const target = event.target as Element;
    const th = target.closest("th[data-col-id]");
    if (th instanceof HTMLTableCellElement && this.editable) {
      this.openColumnMenu(th.dataset.colId!, th);
      return;
    }
    const td = target.closest("td[data-col-id]");
    if (!(td instanceof HTMLTableCellElement)) return;
    // Cmd/Ctrl+click follows a link; a plain click edits the cell.
    const link = target.closest("a");
    if (link && (event.metaKey || event.ctrlKey || !this.editable)) return;
    if (link) event.preventDefault();
    if (td.querySelector(".t3-cell-editor")) return;
    const threads = this.commentsOn(td);
    this.comments?.onActivate(threads[0]?.id ?? null);
    if (this.editable) this.startEditing(td.dataset.rowId!, td.dataset.colId!);
  };

  private editingCell() {
    return this.editing ? this.cells.get(cellKey(this.editing.rowId, this.editing.columnId)) : null;
  }

  /** Opens the cell's editor. `draft` restores an edit in progress across a re-render. */
  private startEditing(rowId: string, columnId: string, draft?: CellValue) {
    this.stopEditing(true);
    this.closePopover();
    const table = this.table;
    const td = this.cells.get(cellKey(rowId, columnId));
    const column = table?.columns.find((candidate) => candidate.id === columnId);
    if (!table || !td || !column) return;
    const value =
      draft !== undefined ? draft : table.rows.find((row) => row.id === rowId)?.cells[columnId];
    td.classList.add("editing");
    this.showCommentButton(td);

    if (column.type === "select") {
      this.editing = { rowId, columnId, read: () => undefined };
      this.openSelect(rowId, column, td);
      return;
    }

    const wrap = element("div", "t3-cell-editor");
    let read: () => CellValue | undefined;
    let first: HTMLInputElement | HTMLTextAreaElement;
    if (column.type === "link") {
      const link = value !== null && typeof value === "object" ? value : null;
      const text = element("input", "t3-cell-input");
      text.placeholder = "Text";
      text.value = link?.text ?? (typeof value === "string" ? value : "");
      const url = element("input", "t3-cell-input");
      url.placeholder = "https://";
      url.type = "url";
      url.value = link?.url ?? "";
      wrap.append(text, url);
      first = text;
      read = () => {
        const next = url.value.trim();
        if (!isSafeUrl(next)) {
          url.setCustomValidity("Use an http(s) or mailto link.");
          url.reportValidity();
          return undefined;
        }
        return text.value.trim() || next ? { text: text.value.trim(), url: next } : null;
      };
    } else if (column.type === "text") {
      const area = element("textarea", "t3-cell-input");
      area.rows = 1;
      area.value = typeof value === "string" ? value : cellText(value);
      const grow = () => {
        area.style.height = "auto";
        area.style.height = `${area.scrollHeight}px`;
      };
      area.addEventListener("input", grow);
      queueMicrotask(grow);
      wrap.append(area);
      first = area;
      read = () => area.value || null;
    } else {
      const input = element("input", "t3-cell-input");
      if (column.type === "date") input.type = "date";
      else input.inputMode = "decimal";
      input.value = value === null || value === undefined ? "" : String(value);
      wrap.append(input);
      first = input;
      read = () => {
        const raw = input.value.trim();
        if (raw === "") return null;
        if (column.type === "date") return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
        const number = Number(raw.replace(/,/g, ""));
        return Number.isFinite(number) ? number : undefined;
      };
    }

    const editing: EditingCell = { rowId, columnId, read };
    this.editing = editing;
    wrap.addEventListener("keydown", (event) => this.onEditorKey(event, editing));
    wrap.addEventListener("focusout", (event) => {
      if (event.relatedTarget instanceof Node && wrap.contains(event.relatedTarget)) return;
      if (this.editing === editing) this.stopEditing(true);
    });
    td.replaceChildren(wrap);
    first.focus();
    if ("select" in first && column.type !== "date") first.select();
  }

  /** Closes the open cell editor, saving its value unless `save` is false. */
  private stopEditing(save: boolean) {
    const editing = this.editing;
    if (!editing) return;
    this.editing = null;
    const table = this.table;
    const td = this.cells.get(cellKey(editing.rowId, editing.columnId));
    const column = table?.columns.find((candidate) => candidate.id === editing.columnId);
    td?.classList.remove("editing");
    if (!table || !td || !column) return;
    const previous = table.rows.find((row) => row.id === editing.rowId)?.cells[editing.columnId];
    const next = save ? editing.read() : undefined;
    if (next !== undefined && JSON.stringify(next ?? null) !== JSON.stringify(previous ?? null)) {
      const updated = setCell(table, editing.rowId, editing.columnId, next);
      this.commit(updated);
      const row = updated.rows.find((candidate) => candidate.id === editing.rowId);
      this.paintCell(td, column, row?.cells[editing.columnId]);
    } else {
      this.paintCell(td, column, previous);
    }
  }

  private onEditorKey(event: KeyboardEvent, editing: EditingCell) {
    if ((event.metaKey || event.ctrlKey) && event.altKey && event.code === "KeyM") {
      event.preventDefault();
      this.commentOn(this.cells.get(cellKey(editing.rowId, editing.columnId)) ?? null);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.stopEditing(false);
      return;
    }
    const target = event.target as HTMLElement;
    // In a link editor, Tab moves from the text field to the url field first.
    const lastField = target === target.parentElement?.lastElementChild;
    if (event.key === "Tab" && (event.shiftKey || lastField)) {
      event.preventDefault();
      this.move(editing, event.shiftKey ? "previous" : "next");
    } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.move(editing, "down");
    }
  }

  /** Saves the open cell and moves to the next one; Tab past the last cell adds a row. */
  private move(
    editing: { rowId: string; columnId: string },
    direction: "next" | "previous" | "down",
  ) {
    this.stopEditing(true);
    const table = this.table;
    if (!table) return;
    const rowIndex = table.rows.findIndex((row) => row.id === editing.rowId);
    const columnIndex = table.columns.findIndex((column) => column.id === editing.columnId);
    if (rowIndex === -1 || columnIndex === -1) return;
    if (direction === "down") {
      const below = table.rows[rowIndex + 1];
      if (below) this.startEditing(below.id, editing.columnId);
      return;
    }
    const width = table.columns.length;
    const flat = rowIndex * width + columnIndex + (direction === "next" ? 1 : -1);
    if (flat < 0) return;
    if (flat >= table.rows.length * width) {
      const next = insertRow(table, table.rows.length);
      this.commitAndRender(next.table);
      this.startEditing(next.rowId, table.columns[0]!.id);
      return;
    }
    this.startEditing(table.rows[Math.floor(flat / width)]!.id, table.columns[flat % width]!.id);
  }

  private openPopover(
    anchor: HTMLElement,
    build: (box: HTMLElement) => void,
    onClose?: () => void,
  ) {
    this.closePopover();
    const box = element("div", "t3-table-popover");
    box.addEventListener("mousedown", (event) => event.stopPropagation());
    build(box);
    const host = this.dom.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    box.style.top = `${rect.bottom - host.top + 4}px`;
    box.style.left = `${Math.max(0, rect.left - host.left)}px`;
    const outside = (event: MouseEvent) => {
      if (!box.contains(event.target as Node)) this.closePopover();
    };
    const close = () => {
      document.removeEventListener("mousedown", outside, true);
      box.remove();
      onClose?.();
    };
    document.addEventListener("mousedown", outside, true);
    this.dom.append(box);
    this.popover = { node: box, close };
  }

  private closePopover() {
    const popover = this.popover;
    this.popover = null;
    popover?.close();
  }

  /** The chip dropdown: pick, clear, or add an option; arrows and Enter work from the filter. */
  private openSelect(rowId: string, column: TableColumn, td: HTMLTableCellElement) {
    const current = this.table?.rows.find((row) => row.id === rowId)?.cells[column.id];
    let chosen = false;
    const choose = (value: string | null, move?: "next" | "previous" | "down") => {
      chosen = true;
      const table = this.table;
      if (!table) return;
      let updated = table;
      if (value !== null && !(column.options ?? []).some((option) => option.value === value)) {
        updated = addOption(updated, column.id, value);
      }
      updated = setCell(updated, rowId, column.id, value);
      this.editing = null;
      this.closePopover();
      td.classList.remove("editing");
      if (updated !== table) this.commitAndRender(updated);
      if (move) this.move({ rowId, columnId: column.id }, move);
    };
    this.openPopover(
      td,
      (box) => {
        box.classList.add("t3-select-menu");
        const filter = element("input", "t3-cell-input");
        filter.placeholder = "Find or add an option";
        const list = element("div", "t3-select-options");
        let active = 0;
        let items: Array<{ value: string | null; node: HTMLElement }> = [];
        const paint = () => {
          const query = filter.value.trim();
          const options = (column.options ?? []).filter((option) =>
            option.value.toLowerCase().includes(query.toLowerCase()),
          );
          items = options.map((option) => {
            const node = element("button", "t3-select-option");
            node.type = "button";
            node.append(chip(option.value, option.color));
            if (option.value === current) node.setAttribute("aria-current", "true");
            return { value: option.value, node };
          });
          if (query && !options.some((option) => option.value === query)) {
            const node = element("button", "t3-select-option", `Add "${query}"`);
            node.type = "button";
            items.push({ value: query, node });
          }
          if (current) {
            const node = element("button", "t3-select-option muted", "Clear");
            node.type = "button";
            items.push({ value: null, node });
          }
          active = Math.min(active, Math.max(0, items.length - 1));
          items.forEach((item, index) => {
            item.node.classList.toggle("active", index === active);
            item.node.addEventListener("click", () => choose(item.value));
          });
          list.replaceChildren(...items.map((item) => item.node));
        };
        filter.addEventListener("input", () => {
          active = 0;
          paint();
        });
        filter.addEventListener("keydown", (event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            active = (active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            items.forEach((item, index) => item.node.classList.toggle("active", index === active));
          } else if (event.key === "Enter") {
            event.preventDefault();
            const item = items[active];
            if (item) choose(item.value, "down");
          } else if (event.key === "Tab") {
            event.preventDefault();
            chosen = true;
            this.editing = null;
            this.closePopover();
            td.classList.remove("editing");
            this.move({ rowId, columnId: column.id }, event.shiftKey ? "previous" : "next");
          } else if (event.key === "Escape") {
            event.preventDefault();
            this.closePopover();
          }
        });
        paint();
        box.append(filter, list);
        queueMicrotask(() => filter.focus());
      },
      () => {
        if (chosen) return;
        this.editing = null;
        td.classList.remove("editing");
      },
    );
  }

  private openRowMenu(rowId: string, anchor: HTMLElement) {
    const table = this.table;
    if (!table) return;
    const index = table.rows.findIndex((row) => row.id === rowId);
    this.openPopover(anchor, (box) => {
      box.classList.add("t3-menu");
      box.append(
        button("tab-menu-item", "Insert row above", () => {
          this.closePopover();
          this.commitAndRender(insertRow(table, index).table);
        }),
        button("tab-menu-item", "Insert row below", () => {
          this.closePopover();
          this.commitAndRender(insertRow(table, index + 1).table);
        }),
        button("tab-menu-item danger", "Delete row", () => {
          this.closePopover();
          this.commitAndRender(deleteRow(table, rowId));
        }),
      );
    });
  }

  private openColumnMenu(columnId: string, anchor: HTMLElement) {
    if (!this.table) return;
    this.stopEditing(true);
    this.openPopover(anchor, (box) => {
      box.classList.add("t3-menu", "t3-column-menu");
      const paint = () => {
        const table = this.table;
        const column = table?.columns.find((candidate) => candidate.id === columnId);
        if (!table || !column) return this.closePopover();
        const index = table.columns.indexOf(column);
        const name = element("input", "t3-cell-input");
        name.value = column.name;
        name.setAttribute("aria-label", "Column name");
        const rename = () => {
          if (name.value === column.name) return;
          this.commitAndRender(updateColumn(table, columnId, (c) => ({ ...c, name: name.value })));
        };
        name.addEventListener("change", rename);
        name.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            rename();
            this.closePopover();
          } else if (event.key === "Escape") this.closePopover();
        });
        const type = element("select", "t3-cell-input");
        type.setAttribute("aria-label", "Column type");
        for (const option of COLUMN_TYPES) {
          const item = element("option", "", COLUMN_TYPE_LABEL[option]);
          item.value = option;
          item.selected = option === column.type;
          type.append(item);
        }
        type.addEventListener("change", () => {
          this.commitAndRender(changeColumnType(table, columnId, type.value as ColumnType));
          paint();
        });
        const nodes: Array<HTMLElement> = [name, type];
        if (column.type === "select") nodes.push(this.optionsEditor(columnId, paint));
        nodes.push(
          button("tab-menu-item", "Insert column left", () => {
            this.closePopover();
            this.commitAndRender(insertColumn(table, index).table);
          }),
          button("tab-menu-item", "Insert column right", () => {
            this.closePopover();
            this.commitAndRender(insertColumn(table, index + 1).table);
          }),
        );
        if (table.columns.length > 1) {
          nodes.push(
            button("tab-menu-item danger", "Delete column", () => {
              this.closePopover();
              this.commitAndRender(deleteColumn(table, columnId));
            }),
          );
        }
        box.replaceChildren(...nodes);
      };
      paint();
      queueMicrotask(() => box.querySelector("input")?.focus());
    });
  }

  private optionsEditor(columnId: string, repaint: () => void) {
    const wrap = element("div", "t3-option-list");
    const table = this.table!;
    const column = table.columns.find((candidate) => candidate.id === columnId)!;
    for (const option of column.options ?? []) {
      const line = element("div", "t3-option-row");
      const value = element("input", "t3-cell-input");
      value.value = option.value;
      value.setAttribute("aria-label", "Option");
      value.addEventListener("change", () => {
        this.commitAndRender(
          editOption(this.table!, columnId, option.value, { ...option, value: value.value.trim() }),
        );
        repaint();
      });
      const color = element("select", "t3-cell-input t3-option-color");
      color.setAttribute("aria-label", "Colour");
      color.dataset.color = option.color;
      for (const name of CHIP_COLORS) {
        const item = element("option", "", name);
        item.value = name;
        item.selected = name === option.color;
        color.append(item);
      }
      color.addEventListener("change", () => {
        this.commitAndRender(
          editOption(this.table!, columnId, option.value, {
            ...option,
            color: color.value as ChipColor,
          }),
        );
        repaint();
      });
      line.append(
        value,
        color,
        button(
          "t3-icon-button",
          "×",
          () => {
            this.commitAndRender(removeOption(this.table!, columnId, option.value));
            repaint();
          },
          "Remove option",
        ),
      );
      wrap.append(line);
    }
    const add = element("input", "t3-cell-input");
    add.placeholder = "Add an option";
    add.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const value = add.value.trim();
      if (!value) return;
      this.commitAndRender(addOption(this.table!, columnId, value));
      repaint();
      wrap.parentElement?.querySelector<HTMLInputElement>(".t3-option-list > input")?.focus();
    });
    wrap.append(add);
    return wrap;
  }
}

function commentSpec(decorations: ReadonlyArray<Decoration>): TableCommentSpec | null {
  for (const decoration of decorations) {
    const spec = (decoration.spec as Record<string, unknown>)[TABLE_COMMENTS_SPEC];
    if (spec) return spec as TableCommentSpec;
  }
  return null;
}
