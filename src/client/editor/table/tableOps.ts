// Pure edits on a rich table. Each returns a new table; the node view writes
// it back into the fence.

import {
  CHIP_COLORS,
  newTableId,
  withCell,
  type CellValue,
  type ChipColor,
  type RichTable,
  type SelectOption,
  type TableColumn,
} from "../../../shared/table.ts";

const uniqueId = (prefix: string, taken: ReadonlyArray<{ readonly id: string }>) => {
  let id = newTableId(prefix);
  while (taken.some((item) => item.id === id)) id = newTableId(prefix);
  return id;
};

export function setCell(
  table: RichTable,
  rowId: string,
  columnId: string,
  value: CellValue,
): RichTable {
  return {
    ...table,
    rows: table.rows.map((row) => (row.id === rowId ? withCell(row, columnId, value) : row)),
  };
}

/** Inserts an empty row at `index` and returns it with the table. */
export function insertRow(
  table: RichTable,
  index: number,
): { readonly table: RichTable; readonly rowId: string } {
  const rowId = uniqueId("r", table.rows);
  return {
    table: { ...table, rows: table.rows.toSpliced(index, 0, { id: rowId, cells: {} }) },
    rowId,
  };
}

export const deleteRow = (table: RichTable, rowId: string): RichTable => ({
  ...table,
  rows: table.rows.filter((row) => row.id !== rowId),
});

export function insertColumn(
  table: RichTable,
  index: number,
): { readonly table: RichTable; readonly columnId: string } {
  const columnId = uniqueId("c", table.columns);
  const column: TableColumn = { id: columnId, name: "Column", type: "text" };
  return { table: { ...table, columns: table.columns.toSpliced(index, 0, column) }, columnId };
}

/** Removes a column and its cells. The last column stays, since a table needs one. */
export function deleteColumn(table: RichTable, columnId: string): RichTable {
  if (table.columns.length <= 1) return table;
  return {
    ...table,
    columns: table.columns.filter((column) => column.id !== columnId),
    rows: table.rows.map((row) => withCell(row, columnId, null)),
  };
}

export function updateColumn(
  table: RichTable,
  columnId: string,
  change: (column: TableColumn) => TableColumn,
): RichTable {
  return {
    ...table,
    columns: table.columns.map((column) => (column.id === columnId ? change(column) : column)),
  };
}

const nextColor = (options: ReadonlyArray<SelectOption>): ChipColor =>
  CHIP_COLORS[options.length % CHIP_COLORS.length]!;

/** Adds a select option (or finds an existing one with that value). */
export function addOption(table: RichTable, columnId: string, value: string): RichTable {
  return updateColumn(table, columnId, (column) => {
    const options = column.options ?? [];
    if (!value || options.some((option) => option.value === value)) return column;
    return { ...column, options: [...options, { value, color: nextColor(options) }] };
  });
}

/** Renames or recolours an option; renamed values follow into the cells. */
export function editOption(
  table: RichTable,
  columnId: string,
  value: string,
  next: SelectOption,
): RichTable {
  const column = table.columns.find((candidate) => candidate.id === columnId);
  const options = column?.options ?? [];
  if (
    !next.value ||
    (next.value !== value && options.some((option) => option.value === next.value))
  ) {
    return table;
  }
  const updated = updateColumn(table, columnId, (current) => ({
    ...current,
    options: options.map((option) => (option.value === value ? next : option)),
  }));
  if (next.value === value) return updated;
  return {
    ...updated,
    rows: updated.rows.map((row) =>
      row.cells[columnId] === value ? withCell(row, columnId, next.value) : row,
    ),
  };
}

/** Removes an option and clears the cells that held it. */
export function removeOption(table: RichTable, columnId: string, value: string): RichTable {
  const updated = updateColumn(table, columnId, (column) => ({
    ...column,
    options: (column.options ?? []).filter((option) => option.value !== value),
  }));
  return {
    ...updated,
    rows: updated.rows.map((row) =>
      row.cells[columnId] === value ? withCell(row, columnId, null) : row,
    ),
  };
}
