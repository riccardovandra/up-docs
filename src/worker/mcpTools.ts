// The agent tools behind `/mcp`. Reads go through `docs.ts`; every write to an
// existing doc goes through `deps.rooms` so open editors receive it live.

import {
  DOC_ROLES,
  isDocRole,
  type DocMember,
  type DocRole,
  type LibraryDoc,
} from "../shared/access.ts";
import {
  findQuote,
  markdownToText,
  parseStructuredAnchor,
  resolveStructuredAnchor,
} from "../shared/anchors.ts";
import { MAX_PROJECT_KEY_LENGTH, normalizeProjectKey } from "../shared/embed.ts";
import {
  DOC_STATUSES,
  type Comment,
  type DocStatus,
  type DocSummary,
  type Tab,
} from "../shared/protocol.ts";
import {
  checkCell,
  checkCells,
  checkTablesIn,
  findTables,
  MAX_TABLE_ROWS,
  newTableId,
  replaceTable,
  TableError,
  withCell,
  type RichTable,
  type TableColumn,
} from "../shared/table.ts";
import { groupThreads } from "../shared/threads.ts";
import { describeWidgetProblems } from "../shared/widget/check.ts";
import { findWidgetFences, spliceFenceSource } from "../shared/widget/fence.ts";
import { MAX_LABEL_LENGTH, rewriteLabel } from "../shared/widget/rewrite.ts";
import { analyzeWidget, formatDiagnostic } from "../shared/widget/validate.ts";
import * as Access from "./access.ts";
import { inviteByEmail, type ApiDeps } from "./api.ts";
import type { Principal } from "./auth.ts";
import * as Comments from "./comments.ts";
import * as DocThreads from "./docThreads.ts";
import * as Docs from "./docs.ts";
import { widgetProblems } from "./widgets.ts";

const MAX_MARKDOWN_LENGTH = 1_000_000;
/** edit_tab re-applies against the latest version this many times before giving up. */
const EDIT_ATTEMPTS = 5;

export class McpToolError extends Error {
  readonly detail: Record<string, unknown>;
  readonly unknownTool: boolean;

  constructor(detail: Record<string, unknown>, unknownTool = false) {
    super(typeof detail.error === "string" ? detail.error : "tool_error");
    this.detail = detail;
    this.unknownTool = unknownTool;
  }
}

function fail(error: string, message: string, extra: Record<string, unknown> = {}): never {
  throw new McpToolError({ error, message, ...extra });
}

interface ToolContext {
  readonly deps: ApiDeps;
  readonly origin: string;
  /** The MCP client's name from `initialize`, else the token's name. */
  readonly agentName: string;
  /** The token; its user's doc roles decide what the agent may do. */
  readonly principal: Principal;
}

type Args = Record<string, unknown>;

function requireString(args: Args, key: string, max = 200): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    return fail("invalid_argument", `"${key}" must be a non-empty string up to ${max} characters.`);
  }
  return value.trim();
}

function optionalString(args: Args, key: string, max = 200): string | undefined {
  return args[key] === undefined || args[key] === null ? undefined : requireString(args, key, max);
}

/** Markdown is taken verbatim, so whitespace and empty strings survive. */
function markdownArg(args: Args, key: string, required: boolean): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return required ? fail("invalid_argument", `"${key}" is required.`) : undefined;
  }
  if (typeof value !== "string") return fail("invalid_argument", `"${key}" must be a string.`);
  if (value.length > MAX_MARKDOWN_LENGTH) return fail("too_large", `"${key}" is too large.`);
  return value;
}

function requireVersion(args: Args, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fail("invalid_argument", `"${key}" must be an integer tab version.`);
  }
  return value;
}

function projectKeyArg(args: Args): string | undefined {
  const raw = optionalString(args, "projectKey", MAX_PROJECT_KEY_LENGTH);
  if (raw === undefined) return undefined;
  return (
    normalizeProjectKey(raw) ??
    fail("invalid_argument", '"projectKey" must be a key from list_projects or docs_cloud_project.')
  );
}

/**
 * The project a doc goes in: `projectId`, else `projectKey` (created from it
 * and `projectName` when new, by the admin only), else no project. Null means
 * no project. Someone else only files into a project they can already see.
 */
async function targetProject(ctx: ToolContext, args: Args): Promise<string | null> {
  const projectId = optionalString(args, "projectId");
  const projectKey = projectKeyArg(args);
  if (projectId !== undefined && projectKey !== undefined) {
    fail("invalid_argument", 'Pass "projectId" or "projectKey", not both.');
  }
  const { userId } = ctx.principal;
  if (projectId !== undefined) {
    if (!(await Access.canSeeProject(ctx.deps.db, projectId, userId))) {
      fail("not_found", "No project with that id.");
    }
    return (await load(Docs.getProject(ctx.deps.db, projectId), "project")).id;
  }
  if (projectKey === undefined) return null;
  const existing = await Docs.findProjectByKey(ctx.deps.db, projectKey);
  if (existing) {
    if (!(await Access.canSeeProject(ctx.deps.db, existing.id, userId))) {
      fail("not_found", "No project with that key.");
    }
    return existing.id;
  }
  if (!Access.isAdmin(userId)) fail("forbidden", "Only the workspace admin creates projects.");
  const project = await Docs.ensureProject(ctx.deps.db, {
    key: projectKey,
    name: optionalString(args, "projectName"),
    now: ctx.deps.now(),
  });
  return project.id;
}

/** Rejects markdown whose ```t3-table blocks do not parse, before anything is written. */
function checkTables(markdown: string, previous?: string): void {
  const problem = checkTablesIn(markdown, previous);
  if (problem) {
    fail("table_invalid", `${problem} Nothing was written.`, {
      format:
        '{"id","columns":[{"id","name","type":"text|select|link|number|date","options?":[{"value","color"}]}],"rows":[{"id","cells":{"<columnId>":value}}]}',
    });
  }
}

const listIds = (items: ReadonlyArray<{ readonly id: string }>) => {
  const ids = items.slice(0, 20).map((item) => `"${item.id}"`);
  return items.length > 20 ? `${ids.join(", ")}, ...` : ids.join(", ");
};

/**
 * Applies `change` to one table in a tab and writes it through the DocRoom,
 * re-reading and re-applying when someone else wrote first. `change` throws a
 * `TableError` for a value or id the table rejects.
 */
async function changeTable<A>(
  ctx: ToolContext,
  tabId: string,
  tableId: string,
  change: (table: RichTable) => { readonly table: RichTable; readonly result: A },
): Promise<{ readonly tab: Tab; readonly result: A }> {
  let tab = await tabWith(ctx, tabId, "editor");
  for (let attempt = 0; attempt < EDIT_ATTEMPTS; attempt += 1) {
    const blocks = findTables(tab.markdown);
    const block = blocks.find(({ parsed }) => parsed.ok && parsed.table.id === tableId);
    if (!block?.parsed.ok) {
      const ids = blocks.flatMap(({ parsed }) => (parsed.ok ? [parsed.table] : []));
      return fail(
        "table_not_found",
        `No t3-table with id "${tableId}" in this tab${ids.length > 0 ? ` (tables: ${listIds(ids)})` : ""}. Re-read it with read_doc.`,
        { url: tabUrl(ctx, tab) },
      );
    }
    let changed: { readonly table: RichTable; readonly result: A };
    try {
      changed = change(block.parsed.table);
    } catch (cause) {
      if (cause instanceof TableError) return fail("invalid_value", cause.message);
      throw cause;
    }
    const markdown = replaceTable(tab.markdown, block, changed.table);
    if (markdown.length > MAX_MARKDOWN_LENGTH) fail("too_large", "The tab would be too large.");
    const written = await ctx.deps.rooms.writeTab(tab.docId, {
      tabId,
      baseVersion: tab.version,
      markdown,
      origin: null,
    });
    if (written.ok) return { tab: written.tab, result: changed.result };
    tab = written.conflict;
  }
  return fail("busy", "The tab kept changing while editing the table. Try again.");
}

function findRow(table: RichTable, rowId: string) {
  const index = table.rows.findIndex((row) => row.id === rowId);
  if (index === -1) throw new TableError(`No row "${rowId}" (rows: ${listIds(table.rows)}).`);
  return index;
}

function findColumn(table: RichTable, colId: string): TableColumn {
  const column = table.columns.find((candidate) => candidate.id === colId);
  if (!column) throw new TableError(`No column "${colId}" (columns: ${listIds(table.columns)}).`);
  return column;
}

/** Refuses markdown that adds or changes an invalid diagram; nothing is written. */
function assertWidgets(markdown: string, previous?: string): void {
  const problems = widgetProblems(markdown, previous);
  if (!problems) return;
  fail(
    "widget_invalid",
    `Nothing was written: a diagram breaks the t3-widget format.\n${describeWidgetProblems(problems)}`,
    { problems },
  );
}

async function load<A>(promise: Promise<A>, what: string): Promise<A> {
  try {
    return await promise;
  } catch (cause) {
    if (cause instanceof Docs.NotFoundError) return fail("not_found", `No ${what} with that id.`);
    if (cause instanceof Docs.InvalidMoveError) {
      return fail("invalid_move", "A tab cannot move under itself or one of its own children.");
    }
    if (cause instanceof Docs.LastTabError) {
      return fail("last_tab", "A doc must keep at least one top-level tab.");
    }
    if (cause instanceof Access.ForbiddenError) {
      return fail("forbidden", `This needs ${cause.required} access to the doc.`);
    }
    if (cause instanceof Access.LastOwnerError) {
      return fail("last_owner", "A doc must keep at least one owner.");
    }
    if (cause instanceof Access.SelfShareError) {
      return fail("self", "That address signs in as you, so it already has your access.");
    }
    throw cause;
  }
}

/** The token user's role on the doc, failing when it is below `minimum`. */
const need = (ctx: ToolContext, docId: string, minimum: DocRole) =>
  load(Access.requireDocRole(ctx.deps.db, docId, ctx.principal.userId, minimum), "doc");

/** A tab the token user may act on with `minimum`. */
async function tabWith(ctx: ToolContext, tabId: string, minimum: DocRole): Promise<Tab> {
  const tab = await load(Docs.getTab(ctx.deps.db, tabId), "tab");
  await need(ctx, tab.docId, minimum);
  return tab;
}

const scopedLibrary = (ctx: ToolContext) =>
  Access.scopeLibrary(ctx.deps.db, {
    library: Docs.listLibrary(ctx.deps.db),
    userId: ctx.principal.userId,
    owners: ctx.deps.owners,
  });

const memberSummary = (member: DocMember) => ({
  email: member.email,
  name: member.user?.name ?? "",
  role: member.role,
  pending: member.pending,
});

const tabUrl = (ctx: ToolContext, tab: Pick<Tab, "docId" | "id">) =>
  `${ctx.origin}/d/${tab.docId}/${tab.id}`;

const tabSummary = (ctx: ToolContext, tab: Tab) => ({
  tabId: tab.id,
  title: tab.title,
  parentTabId: tab.parentTabId,
  position: tab.position,
  version: tab.version,
  url: tabUrl(ctx, tab),
});

const docSummary = (ctx: ToolContext, doc: DocSummary, firstTabId: string | undefined) => ({
  docId: doc.id,
  projectId: doc.projectId,
  title: doc.title,
  status: doc.status,
  updatedAt: new Date(doc.updatedAt).toISOString(),
  url: firstTabId ? tabUrl(ctx, { docId: doc.id, id: firstTabId }) : `${ctx.origin}/d/${doc.id}`,
});

/** Tabs in reading order: each tab followed by its children, siblings by position. */
function readingOrder(tabs: ReadonlyArray<Tab>): ReadonlyArray<{ tab: Tab; depth: number }> {
  const children = new Map<string | null, Array<Tab>>();
  for (const tab of tabs) {
    const siblings = children.get(tab.parentTabId) ?? [];
    siblings.push(tab);
    children.set(tab.parentTabId, siblings);
  }
  const ordered: Array<{ tab: Tab; depth: number }> = [];
  const visit = (parentId: string | null, depth: number) => {
    const siblings = (children.get(parentId) ?? []).toSorted((a, b) => a.position - b.position);
    for (const tab of siblings) {
      ordered.push({ tab, depth });
      visit(tab.id, depth + 1);
    }
  };
  visit(null, 0);
  return ordered;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    count += 1;
  }
  return count;
}

const commentAuthor = (ctx: ToolContext) =>
  Comments.actorAuthor({ kind: "agent", name: ctx.agentName });

const commentSummary = (comment: Comment) => ({
  commentId: comment.id,
  author: comment.author,
  body: comment.body,
  createdAt: new Date(comment.createdAt).toISOString(),
});

async function commentWrite(
  ctx: ToolContext,
  docId: string,
  op: Comments.CommentOp,
): Promise<Comment> {
  const result = await load(ctx.deps.rooms.commentOp(docId, { op, origin: null }), "comment");
  if (result.kind === "deleted") throw new Error("unexpected comment delete");
  return result.comment;
}

/** Writes through the DocRoom, retrying a title-only change against the latest version. */
async function renameTab(ctx: ToolContext, tabId: string, title: string): Promise<Tab> {
  let tab = await tabWith(ctx, tabId, "editor");
  for (let attempt = 0; attempt < EDIT_ATTEMPTS; attempt += 1) {
    const result = await ctx.deps.rooms.writeTab(tab.docId, {
      tabId,
      baseVersion: tab.version,
      title,
      origin: null,
    });
    if (result.ok) return result.tab;
    tab = result.conflict;
  }
  return fail("busy", "The tab kept changing while renaming. Try again.");
}

function findDiagram(ctx: ToolContext, tab: Tab, diagramId: string) {
  const fences = findWidgetFences(tab.markdown);
  const matches = fences.filter((fence) => fence.id === diagramId);
  if (matches.length === 0) {
    fail("not_found", "No diagram with that id in this tab.", {
      diagramIds: fences.map((fence) => fence.id),
      url: tabUrl(ctx, tab),
    });
  }
  if (matches.length > 1) {
    fail("ambiguous_diagram", "Two diagrams in this tab share that id; rename one with edit_tab.");
  }
  return matches[0]!;
}

export const TOOLS = [
  {
    name: "list_projects",
    description:
      "List projects with their doc counts. Projects are T3 Code projects: key is the repository (github.com/owner/repo), or title:<name> for a project without a git remote. noProjectDocCount counts docs in no project.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_project",
    description:
      "Create a project, or return the existing one with the same key. Omit key to make one by name (key title:<name>). T3 Code creates its projects itself, so this is rarely needed.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        key: { type: "string", description: "The T3 Code project key." },
      },
      required: ["name"],
    },
  },
  {
    name: "list_docs",
    description:
      "List docs, most recently updated first. Narrow to one project with projectId or projectKey, or pass noProject: true for the docs in no project.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        projectKey: { type: "string" },
        noProject: { type: "boolean" },
      },
    },
  },
  {
    name: "create_doc",
    description:
      "Create a doc. File it with projectKey (the T3 Code project's key from docs_cloud_project or list_projects; the project is created from projectKey and projectName if new) or projectId; omit both for no project. Pass the skeleton (section headings with one-line placeholders) as markdown for the first tab, then share the returned url with the user before filling it in.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: { type: "string" },
        projectName: {
          type: "string",
          description: "Name for a project created from projectKey; ignored when it exists.",
        },
        projectId: { type: "string" },
        title: { type: "string" },
        markdown: { type: "string", description: "Initial markdown for the first tab." },
      },
      required: ["title"],
    },
  },
  {
    name: "move_doc",
    description:
      "Move a doc to another project by projectKey (created from it and projectName if new) or projectId, or to no project with projectId: null.",
    inputSchema: {
      type: "object",
      properties: {
        docId: { type: "string" },
        projectKey: { type: "string" },
        projectName: { type: "string" },
        projectId: { type: ["string", "null"] },
      },
      required: ["docId"],
    },
  },
  {
    name: "read_doc",
    description:
      "Read a doc: its tab tree (ids, versions, urls) and each tab's markdown. Pass tabId to read only that tab.",
    inputSchema: {
      type: "object",
      properties: { docId: { type: "string" }, tabId: { type: "string" } },
      required: ["docId"],
    },
  },
  {
    name: "create_tab",
    description: "Add a tab to a doc, after its siblings. Nest it with parentTabId.",
    inputSchema: {
      type: "object",
      properties: {
        docId: { type: "string" },
        title: { type: "string" },
        parentTabId: { type: "string" },
        markdown: { type: "string" },
      },
      required: ["docId", "title"],
    },
  },
  {
    name: "edit_tab",
    description:
      "Replace one exact occurrence of `find` in a tab's markdown with `replace`. The main editing tool: use it to fill sections without rewriting the tab. Fails if `find` is missing or appears more than once; include more surrounding text to make it unique.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        find: { type: "string", description: "Exact text currently in the tab." },
        replace: { type: "string" },
      },
      required: ["tabId", "find", "replace"],
    },
  },
  {
    name: "write_tab",
    description:
      "Replace a tab's whole markdown. baseVersion is the version you last read; on a conflict nothing is written and the current version is returned, so re-read and retry.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        markdown: { type: "string" },
        baseVersion: { type: "integer" },
      },
      required: ["tabId", "markdown", "baseVersion"],
    },
  },
  {
    name: "rename_tab",
    description: "Rename a tab.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "string" }, title: { type: "string" } },
      required: ["tabId", "title"],
    },
  },
  {
    name: "move_tab",
    description:
      "Move a tab under parentTabId (null for top level) at a 0-based position among its new siblings; omit position to put it last.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        parentTabId: { type: ["string", "null"] },
        position: { type: "integer", minimum: 0 },
      },
      required: ["tabId", "parentTabId"],
    },
  },
  {
    name: "delete_tab",
    description: "Delete a tab and all of its child tabs. A doc keeps at least one top-level tab.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "string" } },
      required: ["tabId"],
    },
  },
  {
    name: "set_doc_status",
    description: "Set a doc's status.",
    inputSchema: {
      type: "object",
      properties: { docId: { type: "string" }, status: { type: "string", enum: DOC_STATUSES } },
      required: ["docId", "status"],
    },
  },
  {
    name: "update_table_cell",
    description:
      'Set one cell of a ```t3-table block, by the table, row and column ids from its JSON. The value must fit the column type: a string for text, a "YYYY-MM-DD" string for date, a number for number, one of the column\'s option values for select, {"text","url"} for link; null clears the cell. Open editors update live.',
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        tableId: { type: "string" },
        rowId: { type: "string" },
        colId: { type: "string" },
        value: { description: "The new cell value, or null to clear it." },
      },
      required: ["tabId", "tableId", "rowId", "colId", "value"],
    },
  },
  {
    name: "add_table_row",
    description:
      "Add a row to a ```t3-table block. `cells` maps column ids (or exact column names) to values, typed as for update_table_cell; omitted columns stay empty. The row goes after afterRowId, or last. Returns the new row id.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        tableId: { type: "string" },
        cells: { type: "object" },
        afterRowId: { type: "string" },
      },
      required: ["tabId", "tableId", "cells"],
    },
  },
  {
    name: "list_comments",
    description:
      'List comment threads on a doc (optionally one tab): the quoted passage, the structured `anchor` for a table cell ({kind:"cell",blockId,rowId,colId}) or diagram label, whether the thread still has its place (`status`: "anchored", "text_removed" for a quote whose text is gone, "orphaned" for a deleted cell or label), and every reply. Resolved threads are left out unless includeResolved is true.',
    inputSchema: {
      type: "object",
      properties: {
        docId: { type: "string" },
        tabId: { type: "string" },
        includeResolved: { type: "boolean" },
      },
      required: ["docId"],
    },
  },
  {
    name: "create_comment",
    description:
      'Start a comment thread on a passage. `quote` is exact text from the tab (markdown syntax is ignored) and must appear exactly once; include more surrounding words if it repeats. To comment on a ```t3-table cell, pass `anchor` {"kind":"cell","blockId":<table id>,"rowId","colId"} instead of a quote.',
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        quote: { type: "string" },
        anchor: {
          type: "object",
          description:
            'A structured anchor: {"kind":"cell","blockId","rowId","colId"} or {"kind":"label","blockId","textId"}.',
        },
        body: { type: "string", description: "The comment, in markdown." },
      },
      required: ["tabId", "body"],
    },
  },
  {
    name: "reply_comment",
    description: "Reply in a comment thread.",
    inputSchema: {
      type: "object",
      properties: { commentId: { type: "string" }, body: { type: "string" } },
      required: ["commentId", "body"],
    },
  },
  {
    name: "resolve_comment",
    description: "Resolve a comment thread once it has been addressed.",
    inputSchema: {
      type: "object",
      properties: { commentId: { type: "string" } },
      required: ["commentId"],
    },
  },
  {
    name: "list_members",
    description:
      "List the people who can open a doc and their roles (owner, editor, commenter, viewer). Pending people were invited but have not signed in yet.",
    inputSchema: {
      type: "object",
      properties: { docId: { type: "string" } },
      required: ["docId"],
    },
  },
  {
    name: "share_doc",
    description:
      "Give a person access to a doc by email, or change their role. Docs are private until shared. New people get an email with the link. Owner only.",
    inputSchema: {
      type: "object",
      properties: {
        docId: { type: "string" },
        email: { type: "string" },
        role: { type: "string", enum: DOC_ROLES },
      },
      required: ["docId", "email", "role"],
    },
  },
  {
    name: "unshare_doc",
    description: "Remove a person's access to a doc. Owner only; a doc keeps at least one owner.",
    inputSchema: {
      type: "object",
      properties: { docId: { type: "string" }, email: { type: "string" } },
      required: ["docId", "email"],
    },
  },
  {
    name: "read_diagram",
    description:
      "Read one ```t3-widget diagram in a tab: its module code, title, every label's text id and words (with the anchor it sits in), its anchors, and any validation diagnostics.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "string" }, diagramId: { type: "string" } },
      required: ["tabId", "diagramId"],
    },
  },
  {
    name: "edit_diagram_label",
    description:
      "Change the words of one diagram label, found by its data-claude-text-id. Only those words change; the rest of the module stays byte-identical. The smallest way to change a diagram.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        diagramId: { type: "string" },
        textId: { type: "string" },
        value: { type: "string", description: "The label's new words, one line." },
      },
      required: ["tabId", "diagramId", "textId", "value"],
    },
  },
] as const;

type ToolName = (typeof TOOLS)[number]["name"];

const handlers: Record<ToolName, (args: Args, ctx: ToolContext) => Promise<object>> = {
  list_projects: async (_args, ctx) => {
    const library = await scopedLibrary(ctx);
    return {
      projects: library.projects.map((project) => ({
        projectId: project.id,
        key: project.key,
        name: project.name,
        docCount: project.docs.length,
      })),
      noProjectDocCount: library.noProjectDocs.length,
    };
  },

  create_project: async (args, ctx) => {
    if (!Access.isAdmin(ctx.principal.userId)) {
      fail("forbidden", "Only the workspace admin creates projects.");
    }
    const name = requireString(args, "name");
    const key = projectKeyArg(args);
    const now = ctx.deps.now();
    const project =
      key === undefined
        ? await Docs.createProject(ctx.deps.db, name, now)
        : await Docs.ensureProject(ctx.deps.db, { key, name, now });
    return { projectId: project.id, key: project.key, name: project.name };
  },

  list_docs: async (args, ctx) => {
    const projectId = optionalString(args, "projectId");
    const projectKey = projectKeyArg(args);
    const library = await scopedLibrary(ctx);
    let docs: ReadonlyArray<LibraryDoc>;
    if (args.noProject === true) {
      docs = library.noProjectDocs;
    } else if (projectId !== undefined || projectKey !== undefined) {
      const project = library.projects.find(
        (candidate) => candidate.id === projectId || candidate.key === projectKey,
      );
      if (!project) return fail("not_found", "No project with that id or key.");
      docs = project.docs;
    } else {
      docs = [...library.projects.flatMap((project) => project.docs), ...library.noProjectDocs];
    }
    return {
      docs: docs
        .toSorted((a, b) => b.updatedAt - a.updatedAt)
        .map((doc) => ({
          ...docSummary(ctx, doc, undefined),
          role: doc.role,
          owner: doc.owner?.email ?? null,
        })),
    };
  },

  create_doc: async (args, ctx) => {
    const title = requireString(args, "title");
    const markdown = markdownArg(args, "markdown", false);
    const projectId = await targetProject(ctx, args);
    if (markdown) checkTables(markdown);
    if (markdown) assertWidgets(markdown);
    const created = await load(
      Docs.createDoc(ctx.deps.db, {
        projectId,
        title,
        ownerId: ctx.principal.userId,
        now: ctx.deps.now(),
      }),
      "project",
    );
    let tab = created.tabs[0]!;
    if (markdown) {
      const result = await ctx.deps.rooms.writeTab(created.doc.id, {
        tabId: tab.id,
        baseVersion: tab.version,
        markdown,
        origin: null,
      });
      if (result.ok) tab = result.tab;
    }
    return { doc: docSummary(ctx, created.doc, tab.id), tab: tabSummary(ctx, tab) };
  },

  move_doc: async (args, ctx) => {
    const docId = requireString(args, "docId");
    const toNoProject = args.projectId === null && args.projectKey === undefined;
    if (!toNoProject && args.projectId === undefined && args.projectKey === undefined) {
      fail(
        "invalid_argument",
        'Pass "projectKey", "projectId", or "projectId": null for no project.',
      );
    }
    await need(ctx, docId, "editor");
    const projectId = toNoProject ? null : await targetProject(ctx, args);
    const doc = await load(ctx.deps.rooms.setDocProject(docId, { projectId, origin: null }), "doc");
    return { doc: docSummary(ctx, doc, undefined) };
  },

  read_doc: async (args, ctx) => {
    const docId = requireString(args, "docId");
    const tabId = optionalString(args, "tabId");
    const role = await need(ctx, docId, "viewer");
    const { doc, tabs } = await load(Docs.getDoc(ctx.deps.db, docId), "doc");
    const ordered = readingOrder(tabs);
    if (tabId) {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (!tab) fail("not_found", "No tab with that id in this doc.");
      return {
        doc: { ...docSummary(ctx, doc, ordered[0]?.tab.id), role },
        tab: { ...tabSummary(ctx, tab), markdown: tab.markdown },
      };
    }
    const threads = await DocThreads.listDocThreads(ctx.deps.db, docId);
    return {
      doc: { ...docSummary(ctx, doc, ordered[0]?.tab.id), role },
      // T3 Code threads started from this doc ("Start work").
      startedThreads: threads.map(({ environmentId, threadId, title }) => ({
        environmentId,
        threadId,
        title,
      })),
      tabs: ordered.map(({ tab, depth }) => ({
        ...tabSummary(ctx, tab),
        depth,
        markdown: tab.markdown,
      })),
    };
  },

  create_tab: async (args, ctx) => {
    const docId = requireString(args, "docId");
    const title = requireString(args, "title");
    const parentTabId = optionalString(args, "parentTabId") ?? null;
    const markdown = markdownArg(args, "markdown", false) ?? "";
    await need(ctx, docId, "editor");
    checkTables(markdown);
    assertWidgets(markdown);
    if (parentTabId !== null) {
      const parent = await load(Docs.getTab(ctx.deps.db, parentTabId), "parent tab");
      if (parent.docId !== docId) fail("not_found", "The parent tab is in another doc.");
    }
    const tab = await ctx.deps.rooms.createTab(docId, {
      parentTabId,
      title,
      markdown,
      origin: null,
    });
    return { tab: tabSummary(ctx, tab) };
  },

  edit_tab: async (args, ctx) => {
    const tabId = requireString(args, "tabId");
    const find = markdownArg(args, "find", true)!;
    const replace = markdownArg(args, "replace", true)!;
    if (find.length === 0) fail("invalid_argument", '"find" must not be empty.');
    let tab = await tabWith(ctx, tabId, "editor");
    for (let attempt = 0; attempt < EDIT_ATTEMPTS; attempt += 1) {
      const matches = countOccurrences(tab.markdown, find);
      if (matches === 0) {
        fail("no_match", '"find" does not appear in the tab. Re-read it with read_doc.', {
          version: tab.version,
          url: tabUrl(ctx, tab),
        });
      }
      if (matches > 1) {
        fail(
          "ambiguous_match",
          `"find" appears ${matches} times. Include more surrounding text so it matches once.`,
          { version: tab.version, url: tabUrl(ctx, tab) },
        );
      }
      const at = tab.markdown.indexOf(find);
      const markdown = tab.markdown.slice(0, at) + replace + tab.markdown.slice(at + find.length);
      if (markdown.length > MAX_MARKDOWN_LENGTH) fail("too_large", "The tab would be too large.");
      checkTables(markdown, tab.markdown);
      assertWidgets(markdown, tab.markdown);
      const result = await ctx.deps.rooms.writeTab(tab.docId, {
        tabId,
        baseVersion: tab.version,
        markdown,
        origin: null,
      });
      if (result.ok) return { tab: tabSummary(ctx, result.tab) };
      // Someone else wrote first; apply the same edit to their version if it still fits.
      tab = result.conflict;
    }
    return fail("busy", "The tab kept changing while editing. Re-read it and try again.", {
      version: tab.version,
    });
  },

  write_tab: async (args, ctx) => {
    const tabId = requireString(args, "tabId");
    const markdown = markdownArg(args, "markdown", true)!;
    const baseVersion = requireVersion(args, "baseVersion");
    const current = await tabWith(ctx, tabId, "editor");
    checkTables(markdown, current.markdown);
    assertWidgets(markdown, current.markdown);
    const result = await ctx.deps.rooms.writeTab(current.docId, {
      tabId,
      baseVersion,
      markdown,
      origin: null,
    });
    if (result.ok) return { tab: tabSummary(ctx, result.tab) };
    return fail(
      "version_conflict",
      "The tab changed since you read it. Nothing was written; re-read it with read_doc and retry.",
      { currentVersion: result.conflict.version, url: tabUrl(ctx, result.conflict) },
    );
  },

  rename_tab: async (args, ctx) => {
    const tab = await renameTab(ctx, requireString(args, "tabId"), requireString(args, "title"));
    return { tab: tabSummary(ctx, tab) };
  },

  move_tab: async (args, ctx) => {
    const tabId = requireString(args, "tabId");
    const parentTabId = optionalString(args, "parentTabId") ?? null;
    const position = args.position ?? Number.MAX_SAFE_INTEGER;
    if (typeof position !== "number" || !Number.isInteger(position) || position < 0) {
      fail("invalid_argument", '"position" must be a non-negative integer.');
    }
    const current = await tabWith(ctx, tabId, "editor");
    await load(
      ctx.deps.rooms.moveTab(current.docId, { tabId, parentTabId, position, origin: null }),
      "parent tab in this doc",
    );
    return { tab: tabSummary(ctx, await Docs.getTab(ctx.deps.db, tabId)) };
  },

  delete_tab: async (args, ctx) => {
    const tabId = requireString(args, "tabId");
    const current = await tabWith(ctx, tabId, "editor");
    const deletedTabIds = await load(
      ctx.deps.rooms.deleteTab(current.docId, { tabId, origin: null }),
      "tab",
    );
    return { deletedTabIds, docUrl: `${ctx.origin}/d/${current.docId}` };
  },

  set_doc_status: async (args, ctx) => {
    const docId = requireString(args, "docId");
    const status = args.status;
    if (!DOC_STATUSES.includes(status as DocStatus)) {
      fail("invalid_argument", `"status" must be one of ${DOC_STATUSES.join(", ")}.`);
    }
    await need(ctx, docId, "editor");
    const doc = await load(
      ctx.deps.rooms.setDocStatus(docId, { status: status as DocStatus, origin: null }),
      "doc",
    );
    return { doc: docSummary(ctx, doc, undefined) };
  },

  list_comments: async (args, ctx) => {
    const docId = requireString(args, "docId");
    const tabId = optionalString(args, "tabId");
    const includeResolved = args.includeResolved === true;
    await need(ctx, docId, "viewer");
    const { tabs } = await load(Docs.getDoc(ctx.deps.db, docId), "doc");
    if (tabId && !tabs.some((tab) => tab.id === tabId)) {
      fail("not_found", "No tab with that id in this doc.");
    }
    const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
    const texts = new Map<string, string>();
    const textOf = (tab: Tab) => () => {
      const cached = texts.get(tab.id) ?? markdownToText(tab.markdown);
      texts.set(tab.id, cached);
      return cached;
    };
    const comments = await Comments.listComments(ctx.deps.db, { docId, tabId });
    const threads = groupThreads(comments).filter(
      (thread) => includeResolved || thread.root.resolvedAt === null,
    );
    return {
      threads: threads.map(({ root, replies }) => {
        const tab = tabsById.get(root.tabId)!;
        return {
          ...commentSummary(root),
          tabId: root.tabId,
          tabUrl: tabUrl(ctx, tab),
          quote: root.quote,
          anchor: root.anchor,
          status: Comments.anchorStatus(root, tab, textOf(tab)),
          resolved: root.resolvedAt !== null,
          replies: replies.map(commentSummary),
        };
      }),
    };
  },

  create_comment: async (args, ctx) => {
    const tabId = requireString(args, "tabId");
    const body = requireString(args, "body", Comments.MAX_COMMENT_LENGTH);
    if (args.anchor !== undefined && args.anchor !== null) {
      const anchor = parseStructuredAnchor(args.anchor);
      if (!anchor) {
        fail(
          "invalid_argument",
          '"anchor" must be {"kind":"cell","blockId","rowId","colId"} or {"kind":"label","blockId","textId"}.',
        );
      }
      const tab = await tabWith(ctx, tabId, "commenter");
      const target = resolveStructuredAnchor(tab.markdown, anchor);
      if (!target) {
        fail(
          "anchor_not_found",
          "No block, row, column or label with those ids in the tab. Re-read it with read_doc.",
          { url: tabUrl(ctx, tab) },
        );
      }
      const label = typeof args.quote === "string" ? args.quote : "";
      const comment = await commentWrite(ctx, tab.docId, {
        kind: "create",
        tabId,
        anchor: { quote: Comments.structuredQuote(target, label), prefix: "", suffix: "" },
        structuredAnchor: anchor,
        body,
        author: commentAuthor(ctx),
      });
      return {
        comment: {
          ...commentSummary(comment),
          quote: comment.quote,
          anchor: comment.anchor,
          url: tabUrl(ctx, tab),
        },
      };
    }
    const quote = markdownArg(args, "quote", true)!;
    if (quote.length > Comments.MAX_QUOTE_LENGTH) fail("too_large", '"quote" is too long.');
    const tab = await tabWith(ctx, tabId, "commenter");
    const match = findQuote(markdownToText(tab.markdown), quote);
    if (match.kind === "missing") {
      fail("quote_not_found", '"quote" does not appear in the tab. Re-read it with read_doc.', {
        url: tabUrl(ctx, tab),
      });
    }
    if (match.kind === "ambiguous") {
      fail(
        "ambiguous_quote",
        `"quote" appears ${match.count} times. Include more surrounding text so it matches once.`,
        { url: tabUrl(ctx, tab) },
      );
    }
    const comment = await commentWrite(ctx, tab.docId, {
      kind: "create",
      tabId,
      anchor: match.anchor,
      body,
      author: commentAuthor(ctx),
    });
    return { comment: { ...commentSummary(comment), quote: comment.quote, url: tabUrl(ctx, tab) } };
  },

  update_table_cell: async (args, ctx) => {
    const tabId = requireString(args, "tabId");
    const tableId = requireString(args, "tableId");
    const rowId = requireString(args, "rowId");
    const colId = requireString(args, "colId");
    if (!Object.hasOwn(args, "value"))
      fail("invalid_argument", '"value" is required (null clears).');
    const { tab, result } = await changeTable(ctx, tabId, tableId, (table) => {
      const index = findRow(table, rowId);
      const column = findColumn(table, colId);
      const value = checkCell(column, args.value, `"value"`);
      const rows = table.rows.with(index, withCell(table.rows[index]!, colId, value));
      return { table: { ...table, rows }, result: value };
    });
    return { tab: tabSummary(ctx, tab), cell: { tableId, rowId, colId, value: result } };
  },

  add_table_row: async (args, ctx) => {
    const tabId = requireString(args, "tabId");
    const tableId = requireString(args, "tableId");
    const afterRowId = optionalString(args, "afterRowId");
    const raw = args.cells;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      fail("invalid_argument", '"cells" must be an object keyed by column id.');
    }
    const { tab, result } = await changeTable(ctx, tabId, tableId, (table) => {
      if (table.rows.length >= MAX_TABLE_ROWS) {
        throw new TableError(`A table can have at most ${MAX_TABLE_ROWS} rows.`);
      }
      // Column names are accepted too, since that is what an agent sees in a rendered table.
      const byId: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const named = table.columns.filter((column) => column.name === key);
        const id = table.columns.some((column) => column.id === key)
          ? key
          : named.length === 1
            ? named[0]!.id
            : key;
        byId[id] = value;
      }
      const cells = checkCells(table.columns, byId, '"cells"');
      let rowId = newTableId("r");
      while (table.rows.some((row) => row.id === rowId)) rowId = newTableId("r");
      const at = afterRowId === undefined ? table.rows.length : findRow(table, afterRowId) + 1;
      const rows = table.rows.toSpliced(at, 0, { id: rowId, cells });
      return { table: { ...table, rows }, result: rowId };
    });
    return { tab: tabSummary(ctx, tab), row: { tableId, rowId: result } };
  },

  reply_comment: async (args, ctx) => {
    const commentId = requireString(args, "commentId");
    const body = requireString(args, "body", Comments.MAX_COMMENT_LENGTH);
    const target = await load(Comments.getComment(ctx.deps.db, commentId), "comment");
    await need(ctx, target.docId, "commenter");
    const reply = await commentWrite(ctx, target.docId, {
      kind: "reply",
      commentId,
      body,
      author: commentAuthor(ctx),
    });
    return { reply: { ...commentSummary(reply), threadId: reply.parentId } };
  },

  resolve_comment: async (args, ctx) => {
    const commentId = requireString(args, "commentId");
    const target = await load(Comments.getComment(ctx.deps.db, commentId), "comment");
    await need(ctx, target.docId, "commenter");
    const root = await commentWrite(ctx, target.docId, {
      kind: "resolve",
      commentId,
      resolved: true,
    });
    return { threadId: root.id, resolved: true };
  },

  list_members: async (args, ctx) => {
    const docId = requireString(args, "docId");
    await need(ctx, docId, "viewer");
    const members = await Access.listMembers(ctx.deps.db, docId, ctx.deps.owners);
    return { members: members.map(memberSummary) };
  },

  share_doc: async (args, ctx) => {
    const docId = requireString(args, "docId");
    const email = requireString(args, "email", 320);
    if (!email.includes("@")) fail("invalid_argument", '"email" must be an email address.');
    const role = args.role;
    if (!isDocRole(role))
      fail("invalid_argument", `"role" must be one of ${DOC_ROLES.join(", ")}.`);
    await need(ctx, docId, "owner");
    const { member, created } = await load(
      Access.shareDoc(ctx.deps.db, {
        docId,
        email,
        role,
        addedBy: ctx.principal.userId,
        owners: ctx.deps.owners,
        now: ctx.deps.now(),
      }),
      "doc",
    );
    if (created) {
      ctx.deps.waitUntil(
        inviteByEmail(ctx.deps, { docId, to: member.email, principal: ctx.principal }),
      );
    }
    return { member: memberSummary(member), added: created };
  },

  unshare_doc: async (args, ctx) => {
    const docId = requireString(args, "docId");
    const email = requireString(args, "email", 320);
    const role = await need(ctx, docId, "viewer");
    const memberId = await Access.findMemberId(ctx.deps.db, {
      docId,
      email,
      owners: ctx.deps.owners,
    });
    if (!memberId) fail("not_found", "That email has no access to this doc.");
    const { userId } = await load(
      Access.removeMember(ctx.deps.db, {
        docId,
        memberId,
        by: { userId: ctx.principal.userId, role },
      }),
      "doc",
    );
    if (userId) await ctx.deps.rooms.closeSockets(docId, userId);
    const members = await Access.listMembers(ctx.deps.db, docId, ctx.deps.owners);
    return { members: members.map(memberSummary) };
  },

  read_diagram: async (args, ctx) => {
    const tab = await tabWith(ctx, requireString(args, "tabId"), "viewer");
    const fence = findDiagram(ctx, tab, requireString(args, "diagramId"));
    const analysis = analyzeWidget(fence.source);
    return {
      diagramId: fence.id,
      tabId: tab.id,
      version: tab.version,
      url: tabUrl(ctx, tab),
      title: analysis.title,
      viewBox: analysis.viewBox,
      code: fence.source,
      texts: analysis.labels.map((label) => ({
        textId: label.id,
        text: label.text,
        anchor: label.anchor,
      })),
      anchors: analysis.anchors,
      diagnostics: analysis.diagnostics.map(formatDiagnostic),
    };
  },

  edit_diagram_label: async (args, ctx) => {
    const tabId = requireString(args, "tabId");
    const diagramId = requireString(args, "diagramId");
    const textId = requireString(args, "textId", 64);
    const value = requireString(args, "value", MAX_LABEL_LENGTH);
    let tab = await tabWith(ctx, tabId, "editor");
    for (let attempt = 0; attempt < EDIT_ATTEMPTS; attempt += 1) {
      const fence = findDiagram(ctx, tab, diagramId);
      const rewrite = rewriteLabel(fence.source, textId, value);
      if (!rewrite.ok) {
        fail(rewrite.error, rewrite.message, {
          textIds: analyzeWidget(fence.source).labels.map((label) => label.id),
        });
      }
      if (rewrite.replacement === null) {
        return {
          tab: tabSummary(ctx, tab),
          diagramId,
          textId,
          previous: rewrite.previous,
          changed: false,
        };
      }
      const { start, end, text } = rewrite.replacement;
      const markdown = spliceFenceSource(tab.markdown, fence, start, end, text);
      const result = await ctx.deps.rooms.writeTab(tab.docId, {
        tabId,
        baseVersion: tab.version,
        markdown,
        origin: null,
      });
      if (result.ok) {
        return {
          tab: tabSummary(ctx, result.tab),
          diagramId,
          textId,
          previous: rewrite.previous,
          changed: true,
        };
      }
      tab = result.conflict;
    }
    return fail("busy", "The tab kept changing while editing. Re-read it and try again.", {
      version: tab.version,
    });
  },
};

export function callTool(name: string, args: Args, ctx: ToolContext): Promise<object> {
  if (!Object.hasOwn(handlers, name)) {
    throw new McpToolError({ error: "unknown_tool", message: `Unknown tool: ${name}` }, true);
  }
  return handlers[name as ToolName](args, ctx);
}
