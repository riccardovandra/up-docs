// The agent tools behind `/mcp`. Reads go through `docs.ts`; every write to an
// existing doc goes through `deps.rooms` so open editors receive it live.

import {
  DOC_ROLES,
  emailDeliveryNotice,
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
import {
  MAX_PROJECT_KEY_LENGTH,
  normalizeProjectKey,
} from "../shared/embed.ts";
import {
  DOC_STATUSES,
  docGroupArg,
  MAX_DOC_GROUP_LENGTH,
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
import {
  ClaudeDocPushError,
  prepareClaudeDocPush,
  type WidgetLink,
} from "../shared/claudeDocs/toClaudeDoc.ts";
import {
  checkDiagramXml,
  checkDrawioIn,
  diagramPath,
  drawioBlock,
  drawioBlocks,
  drawioDiagramIds,
  drawioRoot,
  isDiagramId,
  isPictureCurrent,
  MAX_DIAGRAM_TITLE_LENGTH,
  MAX_DIAGRAM_XML_BYTES,
  MAX_DRAWIO_PAGE_NAME_LENGTH,
  pageIndexOf,
  pagePicture,
  type Diagram,
  type DiagramSummary,
  type DiagramUse,
} from "../shared/drawio.ts";
import {
  asNamedPage,
  describeDrawio,
  drawioPageProblems,
  drawioWarnings,
  readDrawio,
  uncompressedDrawio,
  type DrawioModel,
} from "../shared/drawioModel.ts";
import { IMAGE_TYPES, MAX_IMAGE_BYTES } from "../shared/images.ts";
import { groupThreads } from "../shared/threads.ts";
import {
  layoutPage,
  MAX_DIAGRAM_COMMENT_LENGTH,
  pinPlacement,
  type DiagramComment,
  type DiagramThread,
} from "../shared/diagramComments.ts";
import { readDrawioLayout, type DrawioPageLayout } from "../shared/drawioModel.ts";
import { describeWidgetProblems } from "../shared/widget/check.ts";
import { findWidgetFences, spliceFenceSource } from "../shared/widget/fence.ts";
import { MAX_LABEL_LENGTH, rewriteLabel } from "../shared/widget/rewrite.ts";
import { analyzeWidget, formatDiagnostic } from "../shared/widget/validate.ts";
import * as Access from "./access.ts";
import { importDeps, inviteByEmail, type ApiDeps } from "./api.ts";
import type { Principal } from "./auth.ts";
import * as Comments from "./comments.ts";
import * as DiagramComments from "./diagramComments.ts";
import * as Diagrams from "./diagrams.ts";
import * as DrawioLinks from "./drawioLinks.ts";
import * as DiagramThemes from "./diagramThemes.ts";
import { isDiagramThemeId, restyleDiagram } from "../shared/diagramTheme.ts";
import {
  effectiveThemeBrief,
  ROLE_COLOUR_FORMAT,
  shouldApplyTheme,
  themeListing,
} from "./mcpThemes.ts";
import * as DocThreads from "./docThreads.ts";
import * as Docs from "./docs.ts";
import * as ImageImport from "./imageImport.ts";
import { checkEmbedsIn } from "../shared/embeds.ts";
import { checkVideosIn } from "../shared/video.ts";
import { widgetProblems } from "./widgets.ts";
import { FORMAT_GUIDES, FORMAT_TOPICS, type FormatTopic } from "./mcpGuide.ts";
import {
  DOC_TYPES,
  docTypeChecklist,
  docTypeSkeleton,
  isDocType,
} from "./docTypes.ts";
import * as Facts from "./projectFacts.ts";
import {
  filledBounds,
  findSheet,
  formatArea,
  isRefusal,
  MAX_CELLS_PER_READ,
  parseArea,
  readCells,
  readSheets,
  workbookFromRecords,
  type Edit,
  type Refusal,
  type Workbook,
} from "../shared/sheet/index.ts";
import {
  DEFAULT_SHEET_TITLE,
  isSheetId,
  MAX_EDITS_PER_LIST,
  MAX_SHEET_TITLE_LENGTH,
  type SheetMeta,
} from "../shared/sheets.ts";
import * as Sheets from "./sheets.ts";

const MAX_MARKDOWN_LENGTH = 1_000_000;
/** edit_tab re-applies against the latest version this many times before giving up. */
const EDIT_ATTEMPTS = 5;

/** read_doc describes this many linked Draw.io diagrams; the rest are listed by id. */
const DOC_DRAWIO_LIMIT = 12;
/** What one diagram may list inside read_doc and a write's result, and in read_drawio. */
const BRIEF_DRAWIO = { shapes: 30, connections: 40 };
const FULL_DRAWIO = { shapes: 300, connections: 400 };
/** One write may link this many diagrams the tab did not link before. */
const MAX_NEW_DRAWIO_LINKS = 20;
/** A larger picture is not attached: clients refuse images of several megabytes. */
const MAX_ATTACHED_PICTURE_BYTES = 3 * 1024 * 1024;

/** A picture handed to the agent beside a tool's JSON; `data` is base64. */
export interface ToolImage {
  readonly data: string;
  readonly mimeType: string;
}

/** A tool result that carries pictures: `body` is the JSON, the images follow it. */
export class ToolResultWithImages {
  readonly body: object;
  readonly images: ReadonlyArray<ToolImage>;

  constructor(body: object, images: ReadonlyArray<ToolImage>) {
    this.body = body;
    this.images = images;
  }
}

export class McpToolError extends Error {
  readonly detail: Record<string, unknown>;
  readonly unknownTool: boolean;

  constructor(detail: Record<string, unknown>, unknownTool = false) {
    super(typeof detail.error === "string" ? detail.error : "tool_error");
    this.detail = detail;
    this.unknownTool = unknownTool;
  }
}

function fail(
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
): never {
  throw new McpToolError({ error, message, ...extra });
}

export interface ToolContext {
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
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max
  ) {
    return fail(
      "invalid_argument",
      `"${key}" must be a non-empty string up to ${max} characters.`,
    );
  }
  return value.trim();
}

function optionalString(
  args: Args,
  key: string,
  max = 200,
): string | undefined {
  return args[key] === undefined || args[key] === null
    ? undefined
    : requireString(args, key, max);
}

/** Markdown is taken verbatim, so whitespace and empty strings survive. */
function markdownArg(
  args: Args,
  key: string,
  required: boolean,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return required
      ? fail("invalid_argument", `"${key}" is required.`)
      : undefined;
  }
  if (typeof value !== "string")
    return fail("invalid_argument", `"${key}" must be a string.`);
  if (value.length > MAX_MARKDOWN_LENGTH)
    return fail("too_large", `"${key}" is too large.`);
  return value;
}

function requireVersion(args: Args, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fail("invalid_argument", `"${key}" must be an integer tab version.`);
  }
  return value;
}

/** `widgetMap`: { [slug]: { nodeId, hash, pub? } }, strings non-empty, pub a non-negative integer. */
function widgetMapArg(args: Args): Record<string, WidgetLink> {
  const value = args.widgetMap;
  const invalid = () =>
    fail(
      "invalid_argument",
      '"widgetMap" must be an object of { nodeId, hash, pub? } by diagram id.',
    );
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  const map: Record<string, WidgetLink> = {};
  for (const [slug, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object") return invalid();
    const { nodeId, hash, pub } = entry as Record<string, unknown>;
    if (
      typeof nodeId !== "string" ||
      !nodeId ||
      typeof hash !== "string" ||
      !hash
    ) {
      return invalid();
    }
    if (pub === undefined || pub === null) {
      map[slug] = { nodeId, hash };
    } else if (typeof pub === "number" && Number.isInteger(pub) && pub >= 0) {
      map[slug] = { nodeId, hash, pub };
    } else {
      return fail(
        "invalid_argument",
        `"widgetMap.${slug}.pub" must be a non-negative integer.`,
      );
    }
  }
  return map;
}

function projectKeyArg(args: Args): string | undefined {
  const raw = optionalString(args, "projectKey", MAX_PROJECT_KEY_LENGTH);
  if (raw === undefined) return undefined;
  return (
    normalizeProjectKey(raw) ??
    fail(
      "invalid_argument",
      '"projectKey" must be a key from list_projects or docs_cloud_project.',
    )
  );
}

/**
 * The project a doc goes in: `projectId`, else `projectKey` (created from it
 * and `projectName` when new, by the admin only), else no project. Null means
 * no project. Someone else only files into a project they can already see.
 */
async function targetProject(
  ctx: ToolContext,
  args: Args,
): Promise<string | null> {
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
  if (!Access.isAdmin(userId))
    fail("forbidden", "Only the workspace admin creates projects.");
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

/**
 * Rejects markdown that adds or changes an invalid ```t3-video, ```t3-embed or
 * ```t3-drawio block, before anything is written.
 */
function checkMediaBlocks(markdown: string, previous?: string): void {
  const problem = checkVideosIn(markdown, previous);
  if (problem) {
    fail("video_invalid", `${problem} Nothing was written.`, {
      format:
        "```t3-video\n<YouTube or Loom link, or /api/videos/<docId>/<file>>\nOptional title\n```",
    });
  }
  const embedProblem = checkEmbedsIn(markdown, previous);
  if (embedProblem) {
    fail("embed_invalid", `${embedProblem} Nothing was written.`, {
      format:
        "```t3-embed\n<https link to a LinkedIn post, X post or X article>\nOptional caption\n```",
    });
  }
  const drawioProblem = checkDrawioIn(markdown, previous);
  if (drawioProblem) {
    fail("drawio_invalid", `${drawioProblem} Nothing was written.`, {
      format:
        "```t3-drawio\n<diagram id from list_drawio or create_drawio>\npage: <page name, optional>\nOptional caption\n```",
    });
  }
}

/**
 * Rejects markdown that links a Draw.io diagram the tab did not link before,
 * unless the token user can see that diagram.
 */
async function checkDrawioLinks(
  ctx: ToolContext,
  markdown: string,
  previous = "",
): Promise<void> {
  const linked = new Set(drawioDiagramIds(previous));
  const added = drawioDiagramIds(markdown).filter((id) => !linked.has(id));
  if (added.length > MAX_NEW_DRAWIO_LINKS) {
    fail(
      "too_many_diagrams",
      `One write can link at most ${MAX_NEW_DRAWIO_LINKS} new Draw.io diagrams. Nothing was written; add them over several writes.`,
    );
  }
  // A block that names a page it did not name before must name one the diagram has.
  const pageKey = (block: { diagramId: string; page: string | null }) =>
    `${block.diagramId}\n${block.page}`;
  const named = new Set(drawioBlocks(previous).map(pageKey));
  const pagesAsked = new Map<string, Set<string>>();
  for (const block of drawioBlocks(markdown)) {
    if (block.page === null || named.has(pageKey(block))) continue;
    const pages = pagesAsked.get(block.diagramId) ?? new Set();
    pages.add(block.page);
    pagesAsked.set(block.diagramId, pages);
  }
  if (pagesAsked.size > MAX_NEW_DRAWIO_LINKS) {
    fail(
      "too_many_diagrams",
      `One write can point blocks of at most ${MAX_NEW_DRAWIO_LINKS} Draw.io diagrams at new pages. Nothing was written; add them over several writes.`,
    );
  }
  for (const diagramId of new Set([...added, ...pagesAsked.keys()])) {
    let diagram: Diagram;
    try {
      ({ diagram } = await Diagrams.requireDiagram(ctx.deps.db, {
        diagramId,
        userId: ctx.principal.userId,
        need: "view",
      }));
    } catch (cause) {
      if (!(cause instanceof Docs.NotFoundError)) throw cause;
      return fail(
        "drawio_not_found",
        `The t3-drawio block links diagram "${diagramId}", which does not exist or is not one you can see. Nothing was written. The block's first line must be a diagram id from list_drawio or create_drawio.`,
        { diagramId },
      );
    }
    const asked = pagesAsked.get(diagramId);
    if (!asked) continue;
    const model = await readDrawio(diagram.xml);
    const names = model.ok ? model.pages.map((page) => page.name) : [];
    for (const page of asked) {
      if (pageIndexOf(names, page) !== -1) continue;
      fail(
        "drawio_page_not_found",
        `The t3-drawio block names page "${page}", which diagram "${diagramId}" does not have. Nothing was written. Use one of its page names, or leave the page line out for the first page.`,
        { diagramId, pages: names },
      );
    }
  }
}

/**
 * Copies the remote images in markdown an agent writes (`![alt](https://...)`)
 * into the doc, so the write saves our copies. Links that fail stay as written
 * and come back in the report, which is null when there were none.
 */
async function withImportedImages(
  ctx: ToolContext,
  docId: string,
  markdown: string,
): Promise<{
  readonly markdown: string;
  readonly images: ImageImport.ImportReport | null;
}> {
  const { markdown: rewritten, report } =
    await ImageImport.importMarkdownImages(importDeps(ctx.deps, ctx.origin), {
      docId,
      markdown,
    });
  if (rewritten.length > MAX_MARKDOWN_LENGTH)
    fail("too_large", "The tab would be too large.");
  return { markdown: rewritten, images: report };
}

/** The `images` field of a write's result, present only when it had image links. */
const imagesField = (images: ImageImport.ImportReport | null) =>
  images ? { images } : {};

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
  change: (table: RichTable) => {
    readonly table: RichTable;
    readonly result: A;
  },
): Promise<{ readonly tab: Tab; readonly result: A }> {
  let tab = await tabWith(ctx, tabId, "editor");
  for (let attempt = 0; attempt < EDIT_ATTEMPTS; attempt += 1) {
    const blocks = findTables(tab.markdown);
    const block = blocks.find(
      ({ parsed }) => parsed.ok && parsed.table.id === tableId,
    );
    if (!block?.parsed.ok) {
      const ids = blocks.flatMap(({ parsed }) =>
        parsed.ok ? [parsed.table] : [],
      );
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
      if (cause instanceof TableError)
        return fail("invalid_value", cause.message);
      throw cause;
    }
    const markdown = replaceTable(tab.markdown, block, changed.table);
    if (markdown.length > MAX_MARKDOWN_LENGTH)
      fail("too_large", "The tab would be too large.");
    const written = await ctx.deps.rooms.writeTab(tab.docId, {
      tabId,
      baseVersion: tab.version,
      markdown,
      origin: null,
    });
    if (written.ok) return { tab: written.tab, result: changed.result };
    tab = written.conflict;
  }
  return fail(
    "busy",
    "The tab kept changing while editing the table. Try again.",
  );
}

function findRow(table: RichTable, rowId: string) {
  const index = table.rows.findIndex((row) => row.id === rowId);
  if (index === -1)
    throw new TableError(`No row "${rowId}" (rows: ${listIds(table.rows)}).`);
  return index;
}

function findColumn(table: RichTable, colId: string): TableColumn {
  const column = table.columns.find((candidate) => candidate.id === colId);
  if (!column)
    throw new TableError(
      `No column "${colId}" (columns: ${listIds(table.columns)}).`,
    );
  return column;
}

/** Refuses markdown that adds or changes an invalid diagram; nothing is written. */
function assertWidgets(markdown: string, previous?: string): void {
  const problems = widgetProblems(markdown, previous);
  if (!problems) return;
  fail(
    "widget_invalid",
    `Nothing was written: a diagram breaks the t3-widget format.\n${describeWidgetProblems(problems)}`,
    {
      problems,
      guide:
        'format_guide {topic: "diagram"} has the full spec and a valid example.',
    },
  );
}

async function load<A>(promise: Promise<A>, what: string): Promise<A> {
  try {
    return await promise;
  } catch (cause) {
    if (cause instanceof Docs.NotFoundError)
      return fail("not_found", `No ${what} with that id.`);
    if (cause instanceof Docs.InvalidMoveError) {
      return fail(
        "invalid_move",
        "A tab cannot move under itself or one of its own children.",
      );
    }
    if (cause instanceof Docs.LastTabError) {
      return fail("last_tab", "A doc must keep at least one top-level tab.");
    }
    if (cause instanceof Access.ForbiddenError) {
      return fail(
        "forbidden",
        `This needs ${cause.required} access to the doc.`,
      );
    }
    if (cause instanceof Access.ReservedEmailError) {
      return fail(
        "invalid_argument",
        "That address is reserved and cannot be shared with.",
      );
    }
    if (cause instanceof Access.LastOwnerError) {
      return fail("last_owner", "A doc must keep at least one owner.");
    }
    if (cause instanceof Facts.TooManyFactsError) {
      return fail(
        "too_many_facts",
        `A project keeps at most ${Facts.MAX_FACTS_PER_PROJECT} facts. Remove or merge some first.`,
      );
    }
    if (cause instanceof Access.SelfShareError) {
      return fail(
        "self",
        "That address signs in as you, so it already has your access.",
      );
    }
    throw cause;
  }
}

/** The token user's role on the doc, failing when it is below `minimum`. */
const need = (ctx: ToolContext, docId: string, minimum: DocRole) =>
  load(
    Access.requireDocRole(ctx.deps.db, docId, ctx.principal.userId, minimum),
    "doc",
  );

/** A tab the token user may act on with `minimum`. */
async function tabWith(
  ctx: ToolContext,
  tabId: string,
  minimum: DocRole,
): Promise<Tab> {
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

/** The `group` argument: a name, or null (and blank) for none. Required fails when absent. */
function groupArg(args: Args, required: boolean): string | null | undefined {
  const group = docGroupArg(args.group);
  if (group === false) {
    fail(
      "invalid_argument",
      `"group" must be text of at most ${MAX_DOC_GROUP_LENGTH} characters, or null.`,
    );
  }
  if (group === undefined && required)
    fail("invalid_argument", 'Pass "group", or null for none.');
  return group;
}

const docSummary = (
  ctx: ToolContext,
  doc: DocSummary,
  firstTabId: string | undefined,
) => ({
  docId: doc.id,
  projectId: doc.projectId,
  title: doc.title,
  status: doc.status,
  group: doc.group,
  updatedAt: new Date(doc.updatedAt).toISOString(),
  url: firstTabId
    ? tabUrl(ctx, { docId: doc.id, id: firstTabId })
    : `${ctx.origin}/d/${doc.id}`,
});

/** A project's facts as agents get them with a doc. */
async function projectFactsFor(ctx: ToolContext, projectId: string | null) {
  if (projectId === null) return [];
  const facts = await Facts.listFacts(ctx.deps.db, projectId);
  return facts.map(({ factId, text }) => ({ factId, text }));
}

/** An existing project the token user can see, by `projectId` or `projectKey`; never creates one. */
async function existingProject(ctx: ToolContext, args: Args) {
  const projectId = optionalString(args, "projectId");
  const projectKey = projectKeyArg(args);
  if ((projectId === undefined) === (projectKey === undefined)) {
    fail("invalid_argument", 'Pass "projectId" or "projectKey".');
  }
  const project =
    projectId !== undefined
      ? await load(Docs.getProject(ctx.deps.db, projectId), "project")
      : await Docs.findProjectByKey(ctx.deps.db, projectKey!);
  if (
    !project ||
    !(await Access.canSeeProject(ctx.deps.db, project.id, ctx.principal.userId))
  ) {
    return fail("not_found", "No project with that id or key.");
  }
  return project;
}

async function requireFactEditor(
  ctx: ToolContext,
  projectId: string,
): Promise<void> {
  if (
    !(await Facts.canEditFacts(ctx.deps.db, projectId, ctx.principal.userId))
  ) {
    fail(
      "forbidden",
      "Changing project facts needs editor access to a doc in the project.",
    );
  }
}

function factTextArg(args: Args, key: string): string {
  const text = requireString(args, key, Facts.MAX_FACT_LENGTH).trim();
  if (!text) fail("invalid_argument", `"${key}" must not be blank.`);
  return text;
}

/** Tabs in reading order: each tab followed by its children, siblings by position. */
function readingOrder(
  tabs: ReadonlyArray<Tab>,
): ReadonlyArray<{ tab: Tab; depth: number }> {
  const children = new Map<string | null, Array<Tab>>();
  for (const tab of tabs) {
    const siblings = children.get(tab.parentTabId) ?? [];
    siblings.push(tab);
    children.set(tab.parentTabId, siblings);
  }
  const ordered: Array<{ tab: Tab; depth: number }> = [];
  const visit = (parentId: string | null, depth: number) => {
    const siblings = (children.get(parentId) ?? []).toSorted(
      (a, b) => a.position - b.position,
    );
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
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + 1)
  ) {
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
  const result = await load(
    ctx.deps.rooms.commentOp(docId, { op, origin: null }),
    "comment",
  );
  if (result.kind === "deleted") throw new Error("unexpected comment delete");
  return result.comment;
}

/** Writes through the DocRoom, retrying a title-only change against the latest version. */
async function renameTab(
  ctx: ToolContext,
  tabId: string,
  title: string,
): Promise<Tab> {
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
    fail(
      "ambiguous_diagram",
      "Two diagrams in this tab share that id; rename one with edit_tab.",
    );
  }
  return matches[0]!;
}

const DRAWIO_GUIDE = {
  guide:
    'format_guide {topic: "drawio"} has the XML skeleton and a valid example.',
};

const PICTURE_PENDING =
  "No current picture: Draw.io draws it the first time a person who manages the diagram opens it or a doc that links it.";

const drawioUrl = (ctx: ToolContext, diagramId: string) =>
  `${ctx.origin}${diagramPath(diagramId)}`;

/** The `diagramId` argument: a diagram's id, or a link to its page or picture. */
/** A one-time Draw.io link for the agent's API token; the link acts as that token. */
async function drawioLinkFor(
  ctx: ToolContext,
  tool: DrawioLinks.DrawioLinkTool,
  args: Args,
) {
  const { principal } = ctx;
  if (principal.kind !== "token") {
    return fail("forbidden", "Draw.io links are for agents signed in with an API token.");
  }
  const { token, expiresAt } = await DrawioLinks.createDrawioLink(ctx.deps.db, {
    tool,
    userId: principal.userId,
    apiTokenId: principal.tokenId,
    agentName: ctx.agentName,
    args,
    now: ctx.deps.now(),
  });
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

/** The whole, uncompressed Draw.io file of a diagram the token user manages. */
export async function drawioDownload(ctx: ToolContext, diagramId: string) {
  const { diagram } = await drawioWith(ctx, diagramId, "edit");
  return {
    xml: await uncompressedDrawio(diagram.xml),
    version: diagram.version,
  };
}

function drawioIdArg(args: Args): string {
  const value = requireString(args, "diagramId", 2000);
  if (isDiagramId(value)) return value;
  const linked = /\/diagrams\/([A-Za-z0-9_-]{1,64})(?:[/?#]|$)/.exec(
    value,
  )?.[1];
  return (
    linked ??
    fail(
      "invalid_argument",
      '"diagramId" must be a Draw.io diagram\'s id, or its link (<origin>/diagrams/<id>).',
    )
  );
}

/** A Draw.io diagram the token user may view or, with "edit", change. */
async function drawioWith(
  ctx: ToolContext,
  diagramId: string,
  need: "view" | "edit",
) {
  try {
    return await Diagrams.requireDiagram(ctx.deps.db, {
      diagramId,
      userId: ctx.principal.userId,
      need,
    });
  } catch (cause) {
    if (cause instanceof Docs.NotFoundError) {
      return fail(
        "not_found",
        "No Draw.io diagram with that id that you can see. list_drawio lists the ones you manage.",
      );
    }
    if (cause instanceof Diagrams.DiagramForbiddenError) {
      return fail(
        "forbidden",
        "Only the diagram's creator and the workspace admin can change it. read_drawio still describes it, and create_drawio draws one of your own.",
      );
    }
    throw cause;
  }
}

const diagramReplySummary = (comment: DiagramComment) => ({
  commentId: comment.id,
  author: comment.author,
  authorKind: comment.authorKind,
  body: comment.body,
  createdAt: new Date(comment.createdAt).toISOString(),
});

/**
 * A diagram thread for an agent: where it is pinned (page, shape id, the
 * shape's label then and now) and whether the shape is still there.
 */
function diagramThreadSummary(
  ctx: ToolContext,
  thread: DiagramThread,
  layouts: ReadonlyArray<DrawioPageLayout>,
) {
  const { anchor } = thread;
  const pin = pinPlacement(anchor, layoutPage(layouts, anchor.page));
  return {
    ...diagramReplySummary(thread),
    diagramId: thread.diagramId,
    url: drawioUrl(ctx, thread.diagramId),
    page: anchor.page,
    shapeId: anchor.shapeId,
    // The label when the thread started; `shapeLabel` is what the shape says now.
    quote: thread.quote,
    ...(pin.shape ? { shapeLabel: pin.shape.label } : {}),
    point: { x: Math.round(anchor.x), y: Math.round(anchor.y) },
    status: pin.status,
    resolved: thread.resolvedAt !== null,
    replies: thread.replies.map(diagramReplySummary),
  };
}

async function diagramThreads(ctx: ToolContext, diagram: Diagram, includeResolved: boolean) {
  const [threads, layouts] = await Promise.all([
    DiagramComments.listDiagramThreads(ctx.deps.db, diagram.id),
    readDrawioLayout(diagram.xml),
  ]);
  return threads
    .filter((thread) => includeResolved || thread.resolvedAt === null)
    .map((thread) => diagramThreadSummary(ctx, thread, layouts ?? []));
}

/**
 * The diagram comment a reply_comment or resolve_comment names: always when
 * `diagramId` is given, else when `commentId` is no doc comment. Null for a
 * doc comment. The token user must manage the diagram.
 */
async function diagramCommentArg(
  ctx: ToolContext,
  args: Args,
  commentId: string,
): Promise<{ readonly comment: DiagramComment; readonly diagram: Diagram } | null> {
  const diagramId = args.diagramId === undefined ? null : drawioIdArg(args);
  if (diagramId === null) {
    try {
      await Comments.getComment(ctx.deps.db, commentId);
      return null;
    } catch (cause) {
      if (!(cause instanceof Docs.NotFoundError)) throw cause;
    }
  }
  let comment: DiagramComment;
  try {
    comment = await DiagramComments.getDiagramComment(ctx.deps.db, commentId);
  } catch (cause) {
    if (!(cause instanceof Docs.NotFoundError)) throw cause;
    return fail("not_found", "No comment with that id.");
  }
  if (diagramId !== null && comment.diagramId !== diagramId) {
    fail("not_found", "No comment with that id on this diagram.");
  }
  const { diagram } = await drawioWith(ctx, comment.diagramId, "edit");
  return { comment, diagram };
}

/**
 * The `xml` argument: Draw.io XML that the store accepts and the editor can
 * open, as one bare `<mxGraphModel>` (one page) or an `<mxfile>` of named
 * `<diagram>` pages. Every page is checked, and every problem is reported.
 */
async function drawioXmlArg(args: Args): Promise<{
  readonly xml: string;
  readonly model: DrawioModel;
  readonly root: "mxfile" | "mxGraphModel";
}> {
  const xml = args.xml;
  if (typeof xml !== "string" || xml.trim() === "") {
    return fail(
      "invalid_argument",
      '"xml" must be Draw.io XML: one <mxGraphModel>, or an <mxfile> with a <diagram name="..."> per page.',
      DRAWIO_GUIDE,
    );
  }
  const problem = checkDiagramXml(xml);
  if (problem) {
    fail(problem.code, `${problem.message} Nothing was saved.`, DRAWIO_GUIDE);
  }
  const model = await readDrawio(xml);
  if (!model.ok) {
    fail(
      "invalid_xml",
      `The Draw.io XML is not well-formed, so the editor could not open it (${model.error}). Nothing was saved.`,
      DRAWIO_GUIDE,
    );
  }
  const root = drawioRoot(xml) ?? "mxGraphModel";
  const problems = drawioPageProblems(model, root === "mxfile");
  if (problems.length > 0) {
    fail(
      "invalid_pages",
      `${problems.length === 1 ? "A page has a problem" : `${problems.length} problems with the pages`}. Nothing was saved.`,
      { problems, ...DRAWIO_GUIDE },
    );
  }
  return { xml, model, root };
}

/** Each page's name, in order: null for a page with none (a bare `<mxGraphModel>`). */
const pageNames = (model: DrawioModel): ReadonlyArray<string | null> =>
  model.ok ? model.pages.map((page) => page.name) : [];

const drawioSummary = (ctx: ToolContext, diagram: DiagramSummary) => ({
  diagramId: diagram.id,
  title: diagram.title,
  projectId: diagram.projectId,
  version: diagram.version,
  updatedAt: new Date(diagram.updatedAt).toISOString(),
  url: drawioUrl(ctx, diagram.id),
});

const drawioUse = (ctx: ToolContext, use: DiagramUse) => ({
  docId: use.docId,
  docTitle: use.docTitle,
  tabId: use.tabId,
  tabTitle: use.tabTitle,
  url: tabUrl(ctx, { docId: use.docId, id: use.tabId }),
});

/** The diagram's project, named only for someone who can see that project. */
async function drawioProject(ctx: ToolContext, projectId: string | null) {
  const { db } = ctx.deps;
  if (
    projectId === null ||
    !(await Access.canSeeProject(db, projectId, ctx.principal.userId))
  ) {
    return null;
  }
  const project = await load(Docs.getProject(db, projectId), "project");
  return { projectId, key: project.key, name: project.name };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

/** The PNG of the diagram's current picture for the agent to look at, or one line saying why not. */
async function drawioPicture(
  ctx: ToolContext,
  diagram: DiagramSummary,
  page: string | null,
): Promise<{ readonly note: string; readonly image: ToolImage | null }> {
  if (!diagram.hasSource) {
    return { note: "None: nothing is drawn in this diagram yet.", image: null };
  }
  if (!isPictureCurrent(diagram)) return { note: PICTURE_PENDING, image: null };
  const shown = pagePicture(diagram, page);
  if (shown.kind === "not_found") {
    return { note: `The diagram has no page "${page}": see pageNames.`, image: null };
  }
  if (shown.kind !== "picture") {
    return {
      note: `No picture of page "${page}" yet: go by its shapes and connections.`,
      image: null,
    };
  }
  const picture = await Diagrams.diagramPicture(
    ctx.deps.images,
    diagram,
    "png",
    shown.index,
  );
  if (!picture) {
    return {
      note: "No PNG of the current picture is stored: go by the shapes and connections.",
      image: null,
    };
  }
  const bytes = new Uint8Array(await new Response(picture.body).arrayBuffer());
  if (bytes.byteLength > MAX_ATTACHED_PICTURE_BYTES) {
    return {
      note: "The picture is too large to attach: go by the shapes and connections.",
      image: null,
    };
  }
  return {
    note:
      page === null
        ? "Attached after this text as a PNG image (the first page)."
        : `Attached after this text as a PNG image of page "${page}".`,
    image: { data: toBase64(bytes), mimeType: picture.contentType },
  };
}

/** What create_drawio and update_drawio return: the diagram, its block and what was read back. */
function drawioWritten(
  ctx: ToolContext,
  diagram: Diagram,
  model: DrawioModel,
  notes: ReadonlyArray<string> = [],
) {
  const warnings = [...notes, ...drawioWarnings(model)];
  return {
    ...drawioSummary(ctx, diagram),
    block: drawioBlock(diagram.id),
    pageNames: pageNames(model),
    ...describeDrawio(model, BRIEF_DRAWIO),
    ...(warnings.length > 0 ? { warnings } : {}),
    picture:
      diagram.hasSource && isPictureCurrent(diagram)
        ? "Unchanged: the stored picture shows this version."
        : PICTURE_PENDING,
    next: "Paste `block` into a tab with edit_tab or write_tab to show the diagram in a doc. It shows the first page; to show another, add a `page: <page name>` line after the id. The last line inside the block is its caption.",
  };
}

/**
 * One linked Draw.io diagram as read_doc describes it. A link alone does not
 * show a diagram, so one the token user cannot see reads as one that is gone.
 */
async function describeLinkedDrawio(ctx: ToolContext, diagramId: string) {
  let found: Awaited<ReturnType<typeof Diagrams.requireDiagram>>;
  try {
    found = await Diagrams.requireDiagram(ctx.deps.db, {
      diagramId,
      userId: ctx.principal.userId,
      need: "view",
    });
  } catch (cause) {
    if (!(cause instanceof Docs.NotFoundError)) throw cause;
    return {
      diagramId,
      missing:
        "No diagram with this id that you can see, so its block shows as missing. Remove the block or link another diagram.",
    };
  }
  return {
    diagramId,
    title: found.diagram.title,
    url: drawioUrl(ctx, diagramId),
    canEdit: found.canEdit,
    ...describeDrawio(await readDrawio(found.diagram.xml), BRIEF_DRAWIO),
  };
}

/**
 * The Draw.io diagrams that `tabs` link, described for read_doc so the agent
 * needs no second call.
 */
async function linkedDrawio(ctx: ToolContext, tabs: ReadonlyArray<Tab>) {
  const ids = [
    ...new Set(tabs.flatMap((tab) => drawioDiagramIds(tab.markdown))),
  ];
  if (ids.length === 0) return {};
  const drawioDiagrams: Array<object> = [];
  // One at a time: a source can be a megabyte, and only its description is kept.
  for (const diagramId of ids.slice(0, DOC_DRAWIO_LIMIT)) {
    drawioDiagrams.push(await describeLinkedDrawio(ctx, diagramId));
  }
  const rest = ids.slice(DOC_DRAWIO_LIMIT);
  return {
    drawioDiagrams,
    ...(rest.length === 0
      ? {}
      : {
          moreDrawioDiagrams: {
            diagramIds: rest,
            note: "Linked too, and left out to keep this short: read_drawio {diagramId} describes one.",
          },
        }),
  };
}

// ---- sheets ----

const SHEET_GUIDE = {
  guide: 'format_guide {topic: "sheet"} has the cell and edit formats.',
};

const sheetUrl = (ctx: ToolContext, sheetId: string) =>
  `${ctx.origin}/sheets/${sheetId}`;

/** The `sheetId` argument: a sheet's id, or its link (<origin>/sheets/<id>). */
function sheetIdArg(args: Args): string {
  const value = requireString(args, "sheetId", 2000);
  if (isSheetId(value)) return value;
  const linked = /\/sheets\/([A-Za-z0-9_-]{1,64})(?:[/?#]|$)/.exec(value)?.[1];
  return (
    linked ??
    fail(
      "invalid_argument",
      '"sheetId" must be a sheet\'s id, or its link (<origin>/sheets/<id>).',
    )
  );
}

/** A sheet the token user manages; any other is not_found, like REST's 404. */
async function sheetWith(ctx: ToolContext, sheetId: string): Promise<SheetMeta> {
  try {
    return await Sheets.requireSheet(ctx.deps.db, {
      sheetId,
      userId: ctx.principal.userId,
    });
  } catch (cause) {
    if (cause instanceof Docs.NotFoundError) {
      return fail(
        "not_found",
        "No sheet with that id that you can see. list_sheets lists yours.",
      );
    }
    throw cause;
  }
}

/** The sheet's stored workbook, with every formula computed. */
async function loadWorkbook(ctx: ToolContext, sheetId: string) {
  const { sheet, records } = await load(
    Sheets.loadSheet(ctx.deps.db, sheetId),
    "sheet",
  );
  return { sheet, workbook: workbookFromRecords(records) };
}

const sheetSummary = (ctx: ToolContext, sheet: SheetMeta) => ({
  sheetId: sheet.id,
  title: sheet.title,
  projectId: sheet.projectId,
  revision: sheet.revision,
  updatedAt: new Date(sheet.updatedAt).toISOString(),
  url: sheetUrl(ctx, sheet.id),
});

/** The sheet with its tabs, all at the workbook's revision. */
function sheetRead(ctx: ToolContext, sheet: SheetMeta, workbook: Workbook) {
  const { revision, sheets } = readSheets(workbook);
  return { ...sheetSummary(ctx, sheet), revision, tabs: sheets };
}

/** A read the engine refused, reworded so the agent knows what to send instead. */
function readRefused(
  workbook: Workbook,
  tab: string,
  range: string,
  refusal: Refusal,
): never {
  const extra = { refusal: refusal.refusal, detail: refusal.detail };
  if (refusal.refusal === "unknownSheet") {
    fail(
      "unknown_sheet",
      `No tab named ${JSON.stringify(tab)}. read_sheet lists the tabs by name and id.`,
      extra,
    );
  }
  if (refusal.refusal === "tooManyCells") {
    const area = parseArea(range)!;
    const found = findSheet(workbook, tab)!;
    const filled = filledBounds(found);
    const c1 = area.startCol ?? 0;
    const c2 = area.endCol ?? Math.max(c1, filled?.c2 ?? 0);
    const r1 = area.startRow ?? 0;
    const rows = Math.max(1, Math.floor(MAX_CELLS_PER_READ / (c2 - c1 + 1)));
    const first = formatArea({
      startRow: r1,
      startCol: c1,
      endRow: r1 + rows - 1,
      endCol: c2,
    });
    fail(
      "too_many_cells",
      `One read returns at most ${MAX_CELLS_PER_READ} cells. Split the range by rows: ${rows} rows of these columns per read, starting with ${first}.`,
      extra,
    );
  }
  return fail(
    "bad_range",
    `${refusal.detail}. Ranges read A1, A1:D20, C:C, 2:2 or F2:F.`,
    extra,
  );
}

/** What edit_sheet returns for a refused list: nothing was applied. */
function editsRefused(refusal: Refusal, revision: number): never {
  const extra = { ...refusal, revision };
  if (refusal.refusal === "baseIsNotTheRevision") {
    fail(
      "edits_refused",
      `Nothing was applied: the sheet is at revision ${revision}, so someone edited it since you read it. Re-read the cells your edits depend on (read_cells), rebuild the list on what is there now and send it again with base ${revision}.`,
      extra,
    );
  }
  const which =
    refusal.editIndex === null
      ? "The edit list"
      : `Edit ${refusal.editIndex} (0-based)`;
  return fail(
    "edits_refused",
    `Nothing was applied: ${which} was refused with ${refusal.refusal}: ${refusal.detail}. The sheet is still at revision ${revision}; fix the list and send it again with base ${revision}.`,
    { ...extra, ...SHEET_GUIDE },
  );
}

/** The project a sheet moves to: projectKey/projectId, or noProject: true for none. */
async function sheetMoveTarget(
  ctx: ToolContext,
  args: Args,
): Promise<string | null | undefined> {
  const named = args.projectId != null || args.projectKey != null;
  if (args.noProject === true) {
    if (named)
      fail(
        "invalid_argument",
        'Pass "noProject" or a project, not both.',
      );
    return null;
  }
  return named ? (await existingProject(ctx, args)).id : undefined;
}

export const TOOLS = [
  {
    name: "format_guide",
    description:
      "The full spec of one doc format, with an example: diagram (t3-widget), drawio (Draw.io diagrams from the library and their pages, t3-drawio), table (t3-table), video (t3-video), embed (t3-embed), image (images in a doc and uploads), sheet (sheets and their formulas), comments (anchors on passages, table cells and diagram labels), sharing, or claude_push. Call it before you first write that format in a session.",
    inputSchema: {
      type: "object",
      properties: { topic: { type: "string", enum: FORMAT_TOPICS } },
      required: ["topic"],
    },
  },
  {
    name: "project_facts",
    description:
      "List a project's standing facts and house rules (tools it uses, names, things never to do). create_doc and read_doc return them too.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: { type: "string" },
        projectId: { type: "string" },
      },
    },
  },
  {
    name: "add_project_fact",
    description:
      'Save a lasting fact about a project, in one sentence, when the user corrects one or states a rule ("We use NocoDB, never Airtable"). Every later doc in the project gets it. Not for one-off details of a single doc.',
    inputSchema: {
      type: "object",
      properties: {
        projectKey: { type: "string" },
        projectId: { type: "string" },
        fact: { type: "string", maxLength: Facts.MAX_FACT_LENGTH },
      },
      required: ["fact"],
    },
  },
  {
    name: "remove_project_fact",
    description:
      "Remove a project fact that is wrong or no longer true, by factId.",
    inputSchema: {
      type: "object",
      properties: { factId: { type: "string" } },
      required: ["factId"],
    },
  },
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
      "Create a doc. File it with projectKey (the T3 Code project's key from docs_cloud_project or list_projects; the project is created from projectKey and projectName if new) or projectId; omit both for no project. Pass the skeleton (section headings with one-line placeholders) as markdown for the first tab, or a type for a ready skeleton, then share the returned url with the user before filling it in. The result lists the project's facts: follow them.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: { type: "string" },
        projectName: {
          type: "string",
          description:
            "Name for a project created from projectKey; ignored when it exists.",
        },
        projectId: { type: "string" },
        title: { type: "string" },
        markdown: {
          type: "string",
          description:
            "Initial markdown for the first tab. Omit it with type to get that type's skeleton.",
        },
        type: {
          type: "string",
          enum: DOC_TYPES,
          description:
            "The kind of doc: plan, spec, explainer, report or client (written to a client). Without markdown, the first tab gets that type's skeleton; the result adds a checklist for filling it.",
        },
        group: {
          type: "string",
          description:
            "Group inside the project, such as Strategy or Posts. Omit for none.",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "set_doc_group",
    description:
      "Put a doc in a group inside its project, such as Strategy, Newsletters or Posts; group: null removes it from its group. list_docs shows each doc's group.",
    inputSchema: {
      type: "object",
      properties: {
        docId: { type: "string" },
        group: { type: ["string", "null"] },
      },
      required: ["docId", "group"],
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
      "Read a doc: its tab tree (ids, versions, urls), each tab's markdown and the project's facts (follow them). Pass tabId to read only that tab; a doc link /d/<docId>/<tabId> gives both. drawioDiagrams describes each Draw.io diagram the tabs link with a ```t3-drawio block (title, shapes, connections), by the id on the block's first line.",
    inputSchema: {
      type: "object",
      properties: { docId: { type: "string" }, tabId: { type: "string" } },
      required: ["docId"],
    },
  },
  {
    name: "create_tab",
    description:
      "Add a tab to a doc, after its siblings. Nest it with parentTabId.",
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
        find: {
          type: "string",
          description: "Exact text currently in the tab.",
        },
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
    name: "import_image",
    description:
      "Copy an image from a public https link into a doc and get the markdown to insert. The doc keeps its own copy, so it survives the link expiring. Image links written with create_doc, create_tab, edit_tab or write_tab are copied the same way automatically; use this to get the path first. For a file on your machine, use prepare_image_upload.",
    inputSchema: {
      type: "object",
      properties: {
        docId: { type: "string" },
        url: {
          type: "string",
          description: "https link to a PNG, JPEG, GIF or WebP image.",
        },
        alt: { type: "string", description: "Alt text for the markdown line." },
      },
      required: ["docId", "url"],
    },
  },
  {
    name: "prepare_image_upload",
    description:
      "Get a one-time link to upload an image file (PNG, JPEG, GIF or WebP, up to 10 MB) from your machine into a doc, such as a screenshot or an exported chart. Send the file with the returned curl command; its JSON reply has the image's url and markdown, which you then insert with edit_tab. The link works once and expires after 10 minutes.",
    inputSchema: {
      type: "object",
      properties: { docId: { type: "string" } },
      required: ["docId"],
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
    description:
      "Delete a tab and all of its child tabs. A doc keeps at least one top-level tab.",
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
      properties: {
        docId: { type: "string" },
        status: { type: "string", enum: DOC_STATUSES },
      },
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
      'List comment threads on a doc (optionally one tab): the quoted passage, the structured `anchor` for a table cell ({kind:"cell",blockId,rowId,colId}) or diagram label, whether the thread still has its place (`status`: "anchored", "text_removed" for a quote whose text is gone, "orphaned" for a deleted cell or label), and every reply. Resolved threads are left out unless includeResolved is true. Pass diagramId (id or link) instead of docId for a Draw.io diagram\'s threads: each has page, shapeId, quote (the shape label), point and status ("shape", "point", "shape_removed").',
    inputSchema: {
      type: "object",
      properties: {
        docId: { type: "string" },
        tabId: { type: "string" },
        diagramId: { type: "string" },
        includeResolved: { type: "boolean" },
      },
    },
  },
  {
    name: "create_comment",
    description:
      'Start a comment thread on a passage. `quote` is exact text from the tab (markdown syntax is ignored) and must appear exactly once; include more surrounding words if it repeats. To comment on a ```t3-table cell, pass `anchor` {"kind":"cell","blockId":<table id>,"rowId","colId"} instead of a quote. On a Draw.io diagram, pass diagramId instead of tabId and anchor {page, shapeId} or {page, x, y}.',
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        diagramId: { type: "string" },
        quote: { type: "string" },
        anchor: {
          type: "object",
          description:
            'A structured anchor: {"kind":"cell","blockId","rowId","colId"} or {"kind":"label","blockId","textId"}.',
        },
        body: { type: "string", description: "The comment, in markdown." },
      },
      required: ["body"],
    },
  },
  {
    name: "reply_comment",
    description: "Reply in a comment thread, on a doc or (with diagramId) a Draw.io diagram.",
    inputSchema: {
      type: "object",
      properties: {
        commentId: { type: "string" },
        body: { type: "string" },
        diagramId: { type: "string" },
      },
      required: ["commentId", "body"],
    },
  },
  {
    name: "resolve_comment",
    description:
      "Resolve a comment thread once it has been addressed. When the thread corrected a lasting fact about the project (a tool, a name, a rule), pass lesson: one sentence saved to the project's facts so later docs get it right.",
    inputSchema: {
      type: "object",
      properties: {
        commentId: { type: "string" },
        diagramId: { type: "string" },
        lesson: {
          type: "string",
          description:
            "A lasting fact this thread taught, saved to the project's facts.",
        },
      },
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
      "Give a person access to a doc by email, or change their role. Docs are private until shared. New people get an email with the link when email is set up; the result says if none was sent. Owner only.",
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
    description:
      "Remove a person's access to a doc. Owner only; a doc keeps at least one owner.",
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
        value: {
          type: "string",
          description: "The label's new words, one line.",
        },
      },
      required: ["tabId", "diagramId", "textId", "value"],
    },
  },
  {
    name: "list_drawio",
    description:
      "List the Draw.io diagrams you manage (the ones you created; every diagram for the workspace admin), most recently changed first, each with the docs that link it. These are library items a person draws in the Draw.io editor, not the ```t3-widget diagrams read_diagram reads. Narrow to one project with projectId or projectKey, or pass noProject: true.",
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
    name: "read_drawio",
    description:
      'Read one Draw.io diagram from the library, by its id (the first line of a ```t3-drawio block) or its link (<origin>/diagrams/<id>): title, project, the docs that use it, pageNames (its pages, in order), its shapes and its connections ("A -> B", "A -[label]-> B"), per page when the file has several, its version, and openComments (open comment threads with page, shapeId and quote). The current picture of the first page, or of `page`, comes attached as a PNG image when there is one. Pass includeXml: true for the Draw.io XML (an <mxfile> holding every page when there are several), which only the diagram\'s creator and the workspace admin get; you need it to change the diagram with update_drawio. To change a diagram with a shell, pass downloadLink: true instead: you get a one-time link that saves the whole file to disk with curl in under a second, and reading the XML into the reply costs minutes on a large file. Edit the file with a script, then send it back with prepare_drawio_upload.',
    inputSchema: {
      type: "object",
      properties: {
        diagramId: {
          type: "string",
          description: "The diagram's id, or its link.",
        },
        includeXml: {
          type: "boolean",
          description: "Put the whole Draw.io XML in the reply. Only for small diagrams (under about 20 KB); use downloadLink when you have a shell.",
        },
        downloadLink: {
          type: "boolean",
          description: "Return a one-time curl command that saves the whole Draw.io file (every page, uncompressed) to disk, instead of putting the XML in the reply. Works for 10 minutes. Creator and workspace admin only.",
        },
        page: {
          type: "string",
          description: "A page name from pageNames: attach that page's picture instead of the first page's.",
        },
      },
      required: ["diagramId"],
    },
  },
  {
    name: "create_drawio",
    description:
      'Draw a new Draw.io diagram into the library from Draw.io XML (format_guide {topic: "drawio"} first). For XML over about 20 KB, or any file already on disk, use prepare_drawio_upload instead: typing a large file into this call takes many minutes. File it like create_doc: projectKey (with projectName if the project is new) or projectId; omit both for no project. Returns the id, the link and `block`, the exact ```t3-drawio block to paste into a doc tab. It opens in the same editor as a hand-drawn diagram. Its picture appears the first time a person who manages the diagram opens it. `theme` gives the project\'s diagram theme and its style lines; when the project has a theme and no cell sets its own fillColor, strokeColor or fontColor, the XML is restyled to it before it is stored (applyTheme: true always restyles, false never).',
    inputSchema: {
      type: "object",
      properties: {
        projectKey: { type: "string" },
        projectName: { type: "string" },
        projectId: { type: "string" },
        title: { type: "string", maxLength: MAX_DIAGRAM_TITLE_LENGTH },
        xml: {
          type: "string",
          description:
            'The whole diagram as uncompressed Draw.io XML: one <mxGraphModel> for one page, or an <mxfile> holding a <diagram name="..."> per page, each with its <mxGraphModel>.',
        },
        applyTheme: {
          type: "boolean",
          description:
            "true: restyle the XML to the project's theme before storing it. false: store it as written. Left out: restyle only when the project has a theme and no cell sets a colour.",
        },
      },
      required: ["title", "xml"],
    },
  },
  {
    name: "update_drawio",
    description:
      "Change a Draw.io diagram you manage: its XML, its title, or both. For XML over about 20 KB, or any file already on disk, use prepare_drawio_upload {diagramId, baseVersion} instead: typing a large file into this call takes many minutes. Pass the version you read as baseVersion. xml replaces the whole source, so start from read_drawio {includeXml: true}: for a diagram of several pages send the whole <mxfile> back (one <mxGraphModel> is refused, since it would delete the other pages), and a page you leave out is deleted. If someone saved since then nothing is written and the current version is returned: read again and redo your change. Every doc that links the diagram shows the change.",
    inputSchema: {
      type: "object",
      properties: {
        diagramId: {
          type: "string",
          description: "The diagram's id, or its link.",
        },
        xml: {
          type: "string",
          description:
            "The whole new source: an <mxfile> with every page, or one <mxGraphModel> for a diagram of one page.",
        },
        title: { type: "string", maxLength: MAX_DIAGRAM_TITLE_LENGTH },
        baseVersion: {
          type: "integer",
          description: "The version read_drawio returned.",
        },
      },
      required: ["diagramId", "baseVersion"],
    },
  },
  {
    name: "prepare_drawio_upload",
    description:
      "Get a one-time link to send a Draw.io file from your machine to the library, so you never type the XML into a tool call (a 200 KB file takes many minutes as text and under a second as a file). With diagramId and baseVersion the file replaces that diagram, exactly like update_drawio; without diagramId it creates a new diagram, exactly like create_drawio (title, and projectKey/projectName or projectId). Send the file with the returned curl command; the reply is the same JSON update_drawio or create_drawio returns, or its error with nothing saved. A refused file leaves the link usable, so fix it and send again. The link works for 10 minutes. The file is the whole source: an <mxfile> with every page, or one <mxGraphModel>.",
    inputSchema: {
      type: "object",
      properties: {
        diagramId: {
          type: "string",
          description: "The diagram to replace, by id or link. Leave out to create a new diagram.",
        },
        baseVersion: {
          type: "integer",
          description: "With diagramId: the version read_drawio returned.",
        },
        title: {
          type: "string",
          maxLength: MAX_DIAGRAM_TITLE_LENGTH,
          description: "Required for a new diagram; optional rename for an existing one.",
        },
        projectKey: { type: "string" },
        projectName: { type: "string" },
        projectId: { type: "string" },
        applyTheme: {
          type: "boolean",
          description: "New diagrams only, as in create_drawio.",
        },
      },
    },
  },
  {
    name: "list_diagram_themes",
    description:
      'List the Draw.io diagram themes: the built-ins (Neutral, the default, and Uplifted) and the workspace\'s custom themes, which everyone can use. Each gives its themeId, its default box role and every role\'s colours as "fill/line/text". The workspace admin makes and edits themes in Settings; agents only choose them. read_drawio and create_drawio give a diagram\'s theme with the exact style lines to write.',
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_diagram_theme",
    description:
      "Choose the theme of one Draw.io diagram you manage (diagramId), or the default theme of a project's diagrams (projectKey or projectId; workspace admin only). themeId null makes the diagram follow its project again, or the project fall back to Neutral. Setting a theme changes no drawing: pass restyle: true (diagrams only) to also restyle the current version to the theme and save it as a new version; the result has the restyle summary and the new version.",
    inputSchema: {
      type: "object",
      properties: {
        diagramId: {
          type: "string",
          description: "The diagram's id, or its link.",
        },
        projectKey: { type: "string" },
        projectId: { type: "string" },
        themeId: {
          type: ["string", "null"],
          description: "A themeId from list_diagram_themes, or null.",
        },
        restyle: { type: "boolean" },
      },
      required: ["themeId"],
    },
  },
  {
    name: "create_sheet",
    description:
      'Create a sheet: a shared spreadsheet with tabs and formulas that people watch change live. File it like create_doc: projectKey (with projectName if the project is new) or projectId; omit both for no project. Returns the sheet, its revision (0), its one tab "Sheet1" and its url; share the url, then build it with edit_sheet (format_guide {topic: "sheet"} first).',
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: MAX_SHEET_TITLE_LENGTH },
        projectKey: { type: "string" },
        projectName: { type: "string" },
        projectId: { type: "string" },
      },
    },
  },
  {
    name: "list_sheets",
    description:
      "List the sheets you manage (the ones you created; every sheet for the workspace admin), most recently changed first. Narrow to one project with projectId or projectKey, or pass noProject: true.",
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
    name: "read_sheet",
    description:
      "Read a sheet's outline: title, url, revision and every tab in order with its id, name, size, frozen rows and columns, and filledRange (the box of filled cells, null when empty). Read cells with read_cells.",
    inputSchema: {
      type: "object",
      properties: {
        sheetId: { type: "string", description: "The sheet's id, or its link." },
      },
      required: ["sheetId"],
    },
  },
  {
    name: "read_cells",
    description: `Read one range of one tab: each cell's formula and computed value, and the revision to send as base with edit_sheet. At most ${MAX_CELLS_PER_READ} cells per read; split larger ranges by rows.`,
    inputSchema: {
      type: "object",
      properties: {
        sheetId: { type: "string", description: "The sheet's id, or its link." },
        sheet: { type: "string", description: "The tab's name or id." },
        range: {
          type: "string",
          description: "A1, A1:D20, C:C, 2:2 or F2:F (to the last filled row).",
        },
      },
      required: ["sheetId", "sheet", "range"],
    },
  },
  {
    name: "edit_sheet",
    description: `Apply one edit list to a sheet: up to ${MAX_EDITS_PER_LIST} edits (writeCells, formatCells, addSheet, insertRows, setSheetSettings and more; format_guide {topic: "sheet"}). base is the revision you last read. The whole list lands as one new revision, which people see at once, or nothing does: a refusal names the edit and gives the current revision.`,
    inputSchema: {
      type: "object",
      properties: {
        sheetId: { type: "string", description: "The sheet's id, or its link." },
        base: {
          type: "integer",
          description: "The revision read_sheet, read_cells or your last edit_sheet returned.",
        },
        edits: {
          type: "array",
          maxItems: MAX_EDITS_PER_LIST,
          items: {
            type: "object",
            properties: { kind: { type: "string" } },
            required: ["kind"],
          },
        },
      },
      required: ["sheetId", "base", "edits"],
    },
  },
  {
    name: "update_sheet",
    description:
      "Rename a sheet (title) or move it to another existing project (projectId or projectKey), or to no project (noProject: true). Open pages update at once. Tabs are renamed with edit_sheet.",
    inputSchema: {
      type: "object",
      properties: {
        sheetId: { type: "string", description: "The sheet's id, or its link." },
        title: { type: "string", maxLength: MAX_SHEET_TITLE_LENGTH },
        projectId: { type: "string" },
        projectKey: { type: "string" },
        noProject: { type: "boolean" },
      },
      required: ["sheetId"],
    },
  },
  {
    name: "prepare_claude_doc_push",
    description:
      'Convert a tab for a push into a Claude Doc (claude.ai) as a tab. Returns the prose markdown with a <?claude block wN?> token per diagram, the embed blocks, each diagram\'s module code, conversion warnings, and the Claude Docs members to send: `batch` (mode "new", for batch(container={"kind":"project","id":claudeDocId})) or `widgetCreates` (mode "update", when the tab was pushed to that Claude Doc before). Writes nothing. Needs editor access.',
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        claudeDocId: {
          type: "string",
          description: "The Claude Doc's id (frame.slug).",
        },
        tabName: {
          type: "string",
          description: "The Claude Doc tab name; defaults to the tab title.",
        },
        order: {
          type: "string",
          description:
            'The new tab\'s order key in the Claude Doc; default "z0".',
        },
      },
      required: ["tabId", "claudeDocId"],
    },
  },
  {
    name: "record_claude_doc_push",
    description:
      "Record a finished push of a tab into a Claude Doc, so the next prepare_claude_doc_push updates the same Claude Doc tab. Replaces the previous record for that tab and Claude Doc. Needs editor access.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        claudeDocId: { type: "string" },
        claudeDocUrl: { type: "string" },
        claudeTabId: {
          type: "string",
          description: "The Claude Docs file id of the tab.",
        },
        claudeBodyId: {
          type: "string",
          description: "The Claude Docs prose node id.",
        },
        widgetMap: {
          type: "object",
          description:
            "{ [diagram slug]: { nodeId, hash, pub? } }, hashes as prepare_claude_doc_push returned them, pub the widget's publish counter.",
          additionalProperties: {
            type: "object",
            properties: {
              nodeId: { type: "string" },
              hash: { type: "string" },
              pub: {
                type: "integer",
                minimum: 0,
                description: "The widget's publish counter at push time.",
              },
            },
            required: ["nodeId", "hash"],
          },
        },
        pushedVersion: {
          type: "integer",
          description: "The tab version that was pushed.",
        },
        pushedRev: {
          type: "integer",
          description: "The prose node rev from the last Claude Docs ack.",
        },
      },
      required: [
        "tabId",
        "claudeDocId",
        "claudeDocUrl",
        "claudeTabId",
        "claudeBodyId",
        "widgetMap",
        "pushedVersion",
        "pushedRev",
      ],
    },
  },
] as const;

type ToolName = (typeof TOOLS)[number]["name"];

const handlers: Record<
  ToolName,
  (args: Args, ctx: ToolContext) => Promise<object>
> = {
  format_guide: async (args) => {
    const topic = requireString(args, "topic", 40);
    if (!Object.hasOwn(FORMAT_GUIDES, topic)) {
      fail(
        "invalid_argument",
        `"topic" must be one of: ${FORMAT_TOPICS.join(", ")}.`,
      );
    }
    return { topic, guide: FORMAT_GUIDES[topic as FormatTopic] };
  },

  project_facts: async (args, ctx) => {
    const project = await existingProject(ctx, args);
    const facts = await Facts.listFacts(ctx.deps.db, project.id);
    return {
      project: { projectId: project.id, key: project.key, name: project.name },
      facts: facts.map(({ factId, text, sourceCommentId, createdAt }) => ({
        factId,
        text,
        sourceCommentId,
        createdAt: new Date(createdAt).toISOString(),
      })),
    };
  },

  add_project_fact: async (args, ctx) => {
    const text = factTextArg(args, "fact");
    const project = await existingProject(ctx, args);
    await requireFactEditor(ctx, project.id);
    const fact = await load(
      Facts.addFact(ctx.deps.db, {
        projectId: project.id,
        text,
        createdBy: ctx.principal.userId,
        now: ctx.deps.now(),
      }),
      "project",
    );
    return {
      fact: { factId: fact.factId, projectId: fact.projectId, text: fact.text },
    };
  },

  remove_project_fact: async (args, ctx) => {
    const factId = requireString(args, "factId");
    const fact = await Facts.getFact(ctx.deps.db, factId);
    if (
      !fact ||
      !(await Access.canSeeProject(
        ctx.deps.db,
        fact.projectId,
        ctx.principal.userId,
      ))
    ) {
      return fail("not_found", "No fact with that id.");
    }
    await requireFactEditor(ctx, fact.projectId);
    await Facts.removeFact(ctx.deps.db, factId);
    return { removed: true, factId };
  },

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
        (candidate) =>
          candidate.id === projectId || candidate.key === projectKey,
      );
      if (!project) return fail("not_found", "No project with that id or key.");
      docs = project.docs;
    } else {
      docs = [
        ...library.projects.flatMap((project) => project.docs),
        ...library.noProjectDocs,
      ];
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
    const type = args.type;
    if (type !== undefined && !isDocType(type)) {
      fail(
        "invalid_argument",
        `"type" must be one of: ${DOC_TYPES.join(", ")}.`,
      );
    }
    const markdown =
      markdownArg(args, "markdown", false) ??
      (type === undefined ? undefined : docTypeSkeleton(type, title));
    const group = groupArg(args, false);
    const projectId = await targetProject(ctx, args);
    if (markdown) checkTables(markdown);
    if (markdown) checkMediaBlocks(markdown);
    if (markdown) assertWidgets(markdown);
    if (markdown) await checkDrawioLinks(ctx, markdown);
    const created = await load(
      Docs.createDoc(ctx.deps.db, {
        projectId,
        title,
        ownerId: ctx.principal.userId,
        now: ctx.deps.now(),
        group: group ?? null,
      }),
      "project",
    );
    let tab = created.tabs[0]!;
    let images: ImageImport.ImportReport | null = null;
    if (markdown) {
      const imported = await withImportedImages(ctx, created.doc.id, markdown);
      images = imported.images;
      const result = await ctx.deps.rooms.writeTab(created.doc.id, {
        tabId: tab.id,
        baseVersion: tab.version,
        markdown: imported.markdown,
        origin: null,
      });
      if (result.ok) tab = result.tab;
    }
    return {
      doc: docSummary(ctx, created.doc, tab.id),
      tab: tabSummary(ctx, tab),
      ...imagesField(images),
      projectFacts: await projectFactsFor(ctx, projectId),
      ...(type === undefined ? {} : { checklist: docTypeChecklist(type) }),
    };
  },

  move_doc: async (args, ctx) => {
    const docId = requireString(args, "docId");
    const toNoProject =
      args.projectId === null && args.projectKey === undefined;
    if (
      !toNoProject &&
      args.projectId === undefined &&
      args.projectKey === undefined
    ) {
      fail(
        "invalid_argument",
        'Pass "projectKey", "projectId", or "projectId": null for no project.',
      );
    }
    await need(ctx, docId, "editor");
    const projectId = toNoProject ? null : await targetProject(ctx, args);
    const doc = await load(
      ctx.deps.rooms.setDocProject(docId, { projectId, origin: null }),
      "doc",
    );
    return { doc: docSummary(ctx, doc, undefined) };
  },

  set_doc_group: async (args, ctx) => {
    const docId = requireString(args, "docId");
    const group = groupArg(args, true);
    await need(ctx, docId, "editor");
    const doc = await load(
      ctx.deps.rooms.setDocGroup(docId, { group: group ?? null, origin: null }),
      "doc",
    );
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
        projectFacts: await projectFactsFor(ctx, doc.projectId),
        tab: { ...tabSummary(ctx, tab), markdown: tab.markdown },
        ...(await linkedDrawio(ctx, [tab])),
      };
    }
    const threads = await DocThreads.listDocThreads(ctx.deps.db, docId);
    return {
      doc: { ...docSummary(ctx, doc, ordered[0]?.tab.id), role },
      projectFacts: await projectFactsFor(ctx, doc.projectId),
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
      ...(await linkedDrawio(ctx, tabs)),
    };
  },

  create_tab: async (args, ctx) => {
    const docId = requireString(args, "docId");
    const title = requireString(args, "title");
    const parentTabId = optionalString(args, "parentTabId") ?? null;
    const markdown = markdownArg(args, "markdown", false) ?? "";
    await need(ctx, docId, "editor");
    checkTables(markdown);
    checkMediaBlocks(markdown);
    assertWidgets(markdown);
    await checkDrawioLinks(ctx, markdown);
    if (parentTabId !== null) {
      const parent = await load(
        Docs.getTab(ctx.deps.db, parentTabId),
        "parent tab",
      );
      if (parent.docId !== docId)
        fail("not_found", "The parent tab is in another doc.");
    }
    const imported = await withImportedImages(ctx, docId, markdown);
    const tab = await ctx.deps.rooms.createTab(docId, {
      parentTabId,
      title,
      markdown: imported.markdown,
      origin: null,
    });
    return { tab: tabSummary(ctx, tab), ...imagesField(imported.images) };
  },

  edit_tab: async (args, ctx) => {
    const tabId = requireString(args, "tabId");
    const find = markdownArg(args, "find", true)!;
    const replaceArg = markdownArg(args, "replace", true)!;
    if (find.length === 0)
      fail("invalid_argument", '"find" must not be empty.');
    let tab = await tabWith(ctx, tabId, "editor");
    // Only the new text's image links are copied; the rest of the tab is as it was.
    const { markdown: replace, images } = await withImportedImages(
      ctx,
      tab.docId,
      replaceArg,
    );
    for (let attempt = 0; attempt < EDIT_ATTEMPTS; attempt += 1) {
      const matches = countOccurrences(tab.markdown, find);
      if (matches === 0) {
        fail(
          "no_match",
          '"find" does not appear in the tab. Re-read it with read_doc.',
          {
            version: tab.version,
            url: tabUrl(ctx, tab),
          },
        );
      }
      if (matches > 1) {
        fail(
          "ambiguous_match",
          `"find" appears ${matches} times. Include more surrounding text so it matches once.`,
          { version: tab.version, url: tabUrl(ctx, tab) },
        );
      }
      const at = tab.markdown.indexOf(find);
      const markdown =
        tab.markdown.slice(0, at) +
        replace +
        tab.markdown.slice(at + find.length);
      if (markdown.length > MAX_MARKDOWN_LENGTH)
        fail("too_large", "The tab would be too large.");
      checkTables(markdown, tab.markdown);
      checkMediaBlocks(markdown, tab.markdown);
      assertWidgets(markdown, tab.markdown);
      await checkDrawioLinks(ctx, markdown, tab.markdown);
      const result = await ctx.deps.rooms.writeTab(tab.docId, {
        tabId,
        baseVersion: tab.version,
        markdown,
        origin: null,
      });
      if (result.ok)
        return { tab: tabSummary(ctx, result.tab), ...imagesField(images) };
      // Someone else wrote first; apply the same edit to their version if it still fits.
      tab = result.conflict;
    }
    return fail(
      "busy",
      "The tab kept changing while editing. Re-read it and try again.",
      {
        version: tab.version,
      },
    );
  },

  write_tab: async (args, ctx) => {
    const tabId = requireString(args, "tabId");
    const markdown = markdownArg(args, "markdown", true)!;
    const baseVersion = requireVersion(args, "baseVersion");
    const current = await tabWith(ctx, tabId, "editor");
    checkTables(markdown, current.markdown);
    checkMediaBlocks(markdown, current.markdown);
    assertWidgets(markdown, current.markdown);
    await checkDrawioLinks(ctx, markdown, current.markdown);
    const imported = await withImportedImages(ctx, current.docId, markdown);
    const result = await ctx.deps.rooms.writeTab(current.docId, {
      tabId,
      baseVersion,
      markdown: imported.markdown,
      origin: null,
    });
    if (result.ok)
      return {
        tab: tabSummary(ctx, result.tab),
        ...imagesField(imported.images),
      };
    return fail(
      "version_conflict",
      "The tab changed since you read it. Nothing was written; re-read it with read_doc and retry.",
      {
        currentVersion: result.conflict.version,
        url: tabUrl(ctx, result.conflict),
      },
    );
  },

  import_image: async (args, ctx) => {
    const docId = requireString(args, "docId");
    const link = requireString(args, "url", ImageImport.MAX_SOURCE_URL_LENGTH);
    const alt = optionalString(args, "alt", 500) ?? "";
    await need(ctx, docId, "editor");
    const result = await ImageImport.importImage(
      importDeps(ctx.deps, ctx.origin),
      {
        docId,
        link,
      },
    );
    if (!result.ok)
      fail(result.error, ImageImport.IMPORT_FAILURE_MESSAGES[result.error]);
    return {
      src: result.src,
      markdown: ImageImport.imageMarkdown(result.src, alt),
    };
  },

  prepare_image_upload: async (args, ctx) => {
    const docId = requireString(args, "docId");
    await need(ctx, docId, "editor");
    const { token, expiresAt } = await ImageImport.createUploadToken(
      ctx.deps.db,
      {
        docId,
        userId: ctx.principal.userId,
        now: ctx.deps.now(),
      },
    );
    const uploadUrl = `${ctx.origin}/api/image-uploads/${token}`;
    return {
      uploadUrl,
      method: "PUT",
      expiresAt: new Date(expiresAt).toISOString(),
      maxBytes: MAX_IMAGE_BYTES,
      contentTypes: Object.keys(IMAGE_TYPES),
      curl: `curl -sS -X PUT -H 'Content-Type: image/png' --data-binary @<file> '${uploadUrl}'`,
      next: "Set Content-Type to the file's type. The reply is JSON with url and markdown; put the markdown in the tab with edit_tab, adding alt text between the brackets. A refused file (wrong type, over the limit) leaves the link usable until it expires.",
    };
  },

  rename_tab: async (args, ctx) => {
    const tab = await renameTab(
      ctx,
      requireString(args, "tabId"),
      requireString(args, "title"),
    );
    return { tab: tabSummary(ctx, tab) };
  },

  move_tab: async (args, ctx) => {
    const tabId = requireString(args, "tabId");
    const parentTabId = optionalString(args, "parentTabId") ?? null;
    const position = args.position ?? Number.MAX_SAFE_INTEGER;
    if (
      typeof position !== "number" ||
      !Number.isInteger(position) ||
      position < 0
    ) {
      fail("invalid_argument", '"position" must be a non-negative integer.');
    }
    const current = await tabWith(ctx, tabId, "editor");
    await load(
      ctx.deps.rooms.moveTab(current.docId, {
        tabId,
        parentTabId,
        position,
        origin: null,
      }),
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
      fail(
        "invalid_argument",
        `"status" must be one of ${DOC_STATUSES.join(", ")}.`,
      );
    }
    await need(ctx, docId, "editor");
    const doc = await load(
      ctx.deps.rooms.setDocStatus(docId, {
        status: status as DocStatus,
        origin: null,
      }),
      "doc",
    );
    return { doc: docSummary(ctx, doc, undefined) };
  },

  list_comments: async (args, ctx) => {
    if (args.diagramId !== undefined) {
      const { diagram } = await drawioWith(ctx, drawioIdArg(args), "view");
      return {
        diagramId: diagram.id,
        title: diagram.title,
        url: drawioUrl(ctx, diagram.id),
        threads: await diagramThreads(ctx, diagram, args.includeResolved === true),
      };
    }
    if (args.docId === undefined) {
      fail("invalid_argument", 'Pass "docId" for a doc\'s comments, or "diagramId" for a diagram\'s.');
    }
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
    if (args.diagramId !== undefined) {
      const body = requireString(args, "body", MAX_DIAGRAM_COMMENT_LENGTH);
      const { diagram } = await drawioWith(ctx, drawioIdArg(args), "edit");
      let placed: Awaited<ReturnType<typeof DiagramComments.resolveNewAnchor>>;
      try {
        placed = await DiagramComments.resolveNewAnchor(diagram.xml, args.anchor ?? {});
      } catch (cause) {
        if (cause instanceof DiagramComments.InvalidDiagramCommentError) {
          return fail(cause.code, `${cause.message} read_drawio lists the pages and shape ids.`);
        }
        throw cause;
      }
      const thread = await DiagramComments.createDiagramThread(ctx.deps.db, {
        diagramId: diagram.id,
        ...placed,
        body,
        author: commentAuthor(ctx),
        now: ctx.deps.now(),
      });
      const layouts = (await readDrawioLayout(diagram.xml)) ?? [];
      return { comment: diagramThreadSummary(ctx, thread, layouts) };
    }
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
        anchor: {
          quote: Comments.structuredQuote(target, label),
          prefix: "",
          suffix: "",
        },
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
    if (quote.length > Comments.MAX_QUOTE_LENGTH)
      fail("too_large", '"quote" is too long.');
    const tab = await tabWith(ctx, tabId, "commenter");
    const match = findQuote(markdownToText(tab.markdown), quote);
    if (match.kind === "missing") {
      fail(
        "quote_not_found",
        '"quote" does not appear in the tab. Re-read it with read_doc.',
        {
          url: tabUrl(ctx, tab),
        },
      );
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
    return {
      comment: {
        ...commentSummary(comment),
        quote: comment.quote,
        url: tabUrl(ctx, tab),
      },
    };
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
      const rows = table.rows.with(
        index,
        withCell(table.rows[index]!, colId, value),
      );
      return { table: { ...table, rows }, result: value };
    });
    return {
      tab: tabSummary(ctx, tab),
      cell: { tableId, rowId, colId, value: result },
    };
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
        throw new TableError(
          `A table can have at most ${MAX_TABLE_ROWS} rows.`,
        );
      }
      // Column names are accepted too, since that is what an agent sees in a rendered table.
      const byId: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(
        raw as Record<string, unknown>,
      )) {
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
      while (table.rows.some((row) => row.id === rowId))
        rowId = newTableId("r");
      const at =
        afterRowId === undefined
          ? table.rows.length
          : findRow(table, afterRowId) + 1;
      const rows = table.rows.toSpliced(at, 0, { id: rowId, cells });
      return { table: { ...table, rows }, result: rowId };
    });
    return { tab: tabSummary(ctx, tab), row: { tableId, rowId: result } };
  },

  reply_comment: async (args, ctx) => {
    const commentId = requireString(args, "commentId");
    const body = requireString(args, "body", Comments.MAX_COMMENT_LENGTH);
    const onDiagram = await diagramCommentArg(ctx, args, commentId);
    if (onDiagram) {
      const reply = await DiagramComments.replyDiagramThread(ctx.deps.db, {
        commentId,
        body,
        author: commentAuthor(ctx),
        now: ctx.deps.now(),
      });
      return {
        reply: { ...diagramReplySummary(reply), threadId: reply.parentId },
        diagramId: onDiagram.diagram.id,
      };
    }
    const target = await load(
      Comments.getComment(ctx.deps.db, commentId),
      "comment",
    );
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
    const onDiagram = await diagramCommentArg(ctx, args, commentId);
    if (onDiagram) {
      const lesson = args.lesson === undefined ? undefined : factTextArg(args, "lesson");
      const projectId = onDiagram.diagram.projectId;
      if (lesson !== undefined) {
        if (projectId === null) {
          fail("no_project", "This diagram is in no project, so the lesson has nowhere to live.");
        }
        await requireFactEditor(ctx, projectId);
      }
      const thread = await DiagramComments.resolveDiagramThread(ctx.deps.db, {
        commentId,
        resolved: true,
        now: ctx.deps.now(),
      });
      if (lesson === undefined || projectId === null) {
        return { threadId: thread.id, diagramId: thread.diagramId, resolved: true };
      }
      const fact = await load(
        Facts.addFact(ctx.deps.db, {
          projectId,
          text: lesson,
          createdBy: ctx.principal.userId,
          sourceCommentId: thread.id,
          now: ctx.deps.now(),
        }),
        "project",
      );
      return {
        threadId: thread.id,
        diagramId: thread.diagramId,
        resolved: true,
        fact: { factId: fact.factId, text: fact.text },
      };
    }
    const target = await load(
      Comments.getComment(ctx.deps.db, commentId),
      "comment",
    );
    await need(ctx, target.docId, "commenter");
    const lesson =
      args.lesson === undefined ? undefined : factTextArg(args, "lesson");
    let projectId: string | null = null;
    if (lesson !== undefined) {
      projectId = (await load(Docs.getDoc(ctx.deps.db, target.docId), "doc"))
        .doc.projectId;
      if (projectId === null) {
        fail(
          "no_project",
          "This doc is in no project, so the lesson has nowhere to live.",
        );
      }
      await requireFactEditor(ctx, projectId);
    }
    const root = await commentWrite(ctx, target.docId, {
      kind: "resolve",
      commentId,
      resolved: true,
    });
    if (lesson === undefined || projectId === null)
      return { threadId: root.id, resolved: true };
    const fact = await load(
      Facts.addFact(ctx.deps.db, {
        projectId,
        text: lesson,
        createdBy: ctx.principal.userId,
        sourceCommentId: root.id,
        now: ctx.deps.now(),
      }),
      "project",
    );
    return {
      threadId: root.id,
      resolved: true,
      fact: { factId: fact.factId, text: fact.text },
    };
  },

  list_members: async (args, ctx) => {
    const docId = requireString(args, "docId");
    await need(ctx, docId, "viewer");
    const members = await Access.listMembers(
      ctx.deps.db,
      docId,
      ctx.deps.owners,
    );
    return { members: members.map(memberSummary) };
  },

  share_doc: async (args, ctx) => {
    const docId = requireString(args, "docId");
    const email = requireString(args, "email", 320);
    if (!email.includes("@"))
      fail("invalid_argument", '"email" must be an email address.');
    const role = args.role;
    if (!isDocRole(role))
      fail(
        "invalid_argument",
        `"role" must be one of ${DOC_ROLES.join(", ")}.`,
      );
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
    if (!created) return { member: memberSummary(member), added: false };
    const delivery = await inviteByEmail(ctx.deps, {
      docId,
      to: member.email,
      principal: ctx.principal,
    });
    const notice = emailDeliveryNotice(delivery, member.email);
    return {
      member: memberSummary(member),
      added: true,
      emailSent: delivery === "sent",
      ...(notice ? { notice, docUrl: `${ctx.origin}/d/${docId}` } : {}),
    };
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
    const members = await Access.listMembers(
      ctx.deps.db,
      docId,
      ctx.deps.owners,
    );
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
    return fail(
      "busy",
      "The tab kept changing while editing. Re-read it and try again.",
      {
        version: tab.version,
      },
    );
  },

  list_drawio: async (args, ctx) => {
    const { db } = ctx.deps;
    const { userId } = ctx.principal;
    const projectId =
      args.noProject === true
        ? null
        : args.projectId != null || args.projectKey != null
          ? (await existingProject(ctx, args)).id
          : undefined;
    const [diagrams, uses] = await Promise.all([
      Diagrams.listDiagrams(db, { userId, projectId }),
      Diagrams.diagramUsesById(db, userId),
    ]);
    return {
      diagrams: diagrams.map((diagram) => ({
        ...drawioSummary(ctx, diagram),
        usedIn: (uses.get(diagram.id) ?? []).map((use) => drawioUse(ctx, use)),
      })),
    };
  },

  read_drawio: async (args, ctx) => {
    const diagramId = drawioIdArg(args);
    const page = optionalString(args, "page", MAX_DRAWIO_PAGE_NAME_LENGTH) ?? null;
    const { diagram, canEdit } = await drawioWith(ctx, diagramId, "view");
    if (args.includeXml === true && !canEdit) {
      fail(
        "forbidden",
        "Only the diagram's creator and the workspace admin get its Draw.io XML. Call read_drawio without includeXml for its shapes, connections and picture.",
      );
    }
    if (args.downloadLink === true && !canEdit) {
      fail(
        "forbidden",
        "Only the diagram's creator and the workspace admin can download its Draw.io file. Call read_drawio without downloadLink for its shapes, connections and picture.",
      );
    }
    const download =
      args.downloadLink === true
        ? await drawioLinkFor(ctx, "download", { diagramId })
        : null;
    const [project, usage, picture, model, comments] = await Promise.all([
      drawioProject(ctx, diagram.projectId),
      Diagrams.diagramUsage(ctx.deps.db, {
        diagramId,
        userId: ctx.principal.userId,
      }),
      drawioPicture(ctx, diagram, page),
      readDrawio(diagram.xml),
      diagramThreads(ctx, diagram, false),
    ]);
    const names = pageNames(model);
    const body = {
      ...drawioSummary(ctx, diagram),
      pageNames: names,
      project,
      canEdit,
      usedIn: usage.uses.map((use) => drawioUse(ctx, use)),
      // How many docs the person is not on is for those who manage the diagram.
      ...(canEdit && usage.otherDocs > 0
        ? { usedInOtherDocs: usage.otherDocs }
        : {}),
      ...describeDrawio(model, FULL_DRAWIO),
      // Open comment threads, pinned to a shape (shapeId) or a point on a page.
      ...(comments.length > 0 ? { openComments: comments } : {}),
      theme: effectiveThemeBrief(
        await DiagramThemes.effectiveDiagramTheme(ctx.deps.db, diagramId),
      ),
      picture: picture.note,
      ...(download
        ? {
            download: {
              url: `${ctx.origin}/api/diagram-downloads/${download.token}`,
              expiresAt: download.expiresAt,
              curl: `curl -sS -f -o <file.drawio> '${ctx.origin}/api/diagram-downloads/${download.token}'`,
              next: "Run the curl command to save the whole file (every page, uncompressed). The link works once. Change the file with a script, then send it back with prepare_drawio_upload {diagramId, baseVersion: this version}.",
            },
          }
        : {}),
      ...(args.includeXml === true
        ? {
            // Compressed pages come written out, so every page can be read and changed.
            xml: await uncompressedDrawio(diagram.xml),
            ...(names.length > 1
              ? {
                  xmlNote: `The whole file: an <mxfile> with all ${names.length} pages. Change the pages you need and send the whole <mxfile> back to update_drawio; a page you leave out is deleted.`,
                }
              : {}),
          }
        : {}),
    };
    return picture.image
      ? new ToolResultWithImages(body, [picture.image])
      : body;
  },

  create_drawio: async (args, ctx) => {
    const title = requireString(args, "title", MAX_DIAGRAM_TITLE_LENGTH);
    if (args.applyTheme != null && typeof args.applyTheme !== "boolean") {
      fail("invalid_argument", '"applyTheme" must be true or false.');
    }
    const applyTheme = args.applyTheme ?? undefined;
    const written = await drawioXmlArg(args);
    const projectId = await targetProject(ctx, args);
    const effective = await load(
      DiagramThemes.effectiveProjectTheme(ctx.deps.db, projectId),
      "project",
    );
    let { xml, model } = written;
    let applied: string;
    if (await shouldApplyTheme(applyTheme, effective, xml)) {
      const restyled = await restyleDiagram(xml, effective.theme);
      if (!restyled.ok) {
        fail("invalid_xml", `The Draw.io XML could not be restyled (${restyled.error}). Nothing was saved.`, DRAWIO_GUIDE);
      }
      xml = restyled.xml;
      model = await readDrawio(xml);
      applied = `Restyled to the theme "${effective.theme.name}" before saving: ${restyled.summary.changed} cells changed. Write new cells with theme.styleGuide.`;
    } else {
      applied =
        applyTheme === false
          ? "Stored as written (applyTheme: false)."
          : effective.source === "default"
            ? "Stored as written: the project has no theme of its own (Neutral, Draw.io's own look)."
            : `Stored as written, keeping the colours its cells set. set_diagram_theme {diagramId, themeId: "${effective.theme.id}", restyle: true} restyles it to the theme.`;
    }
    const diagram = await load(
      Diagrams.createDiagram(ctx.deps.db, {
        projectId,
        title,
        xml,
        createdBy: ctx.principal.userId,
        now: ctx.deps.now(),
      }),
      "project",
    );
    return {
      ...drawioWritten(ctx, diagram, model),
      theme: { ...effectiveThemeBrief(effective), applied },
    };
  },

  update_drawio: async (args, ctx) => {
    const diagramId = drawioIdArg(args);
    const title = optionalString(args, "title", MAX_DIAGRAM_TITLE_LENGTH);
    const { baseVersion } = args;
    if (typeof baseVersion !== "number" || !Number.isInteger(baseVersion)) {
      fail(
        "invalid_argument",
        '"baseVersion" is required: pass the integer version read_drawio returned, so a newer save is not overwritten.',
      );
    }
    if (args.xml == null && title === undefined) {
      fail("invalid_argument", 'Pass "xml", "title" or both.');
    }
    const { diagram: stored } = await drawioWith(ctx, diagramId, "edit");
    const conflict = (currentVersion: number) =>
      fail(
        "version_conflict",
        "The diagram changed since you read it. Nothing was written; read it again with read_drawio {includeXml: true} and redo your change.",
        { currentVersion, url: drawioUrl(ctx, diagramId) },
      );
    if (stored.version !== baseVersion) conflict(stored.version);
    const written = args.xml == null ? null : await drawioXmlArg(args);
    let xml = written?.xml;
    const notes: Array<string> = [];
    if (written) {
      const storedModel = await readDrawio(stored.xml);
      const before = pageNames(storedModel);
      if (written.root === "mxGraphModel" && before.length > 1) {
        // One page sent for a file of several would replace them all: refuse.
        fail(
          "would_delete_pages",
          `This diagram has ${before.length} pages, and "xml" is one <mxGraphModel>, which would replace all of them with a single page. Nothing was saved. Read the whole file with read_drawio {includeXml: true}, change the page you need inside its <mxfile>, and send the whole <mxfile> back.`,
          { pageNames: before, ...DRAWIO_GUIDE },
        );
      }
      // One page for a one-page file: the drawing changes, the page keeps its name and id.
      const only = storedModel.ok && before.length === 1 ? storedModel.pages[0] : undefined;
      if (written.root === "mxGraphModel" && only?.name != null) {
        xml = asNamedPage(written.xml, { name: only.name, id: only.id });
      }
      if (written.root === "mxfile") {
        const after = pageNames(written.model);
        const gone = before.filter(
          (name): name is string => name !== null && pageIndexOf(after, name) === -1,
        );
        if (gone.length > 0) {
          notes.push(
            `Pages deleted: ${gone.map((name) => `"${name}"`).join(", ")}. A doc block that names one of them now shows "Page not found".`,
          );
        }
      }
    }
    const result = await load(
      Diagrams.updateDiagram(ctx.deps.db, {
        diagramId,
        title,
        xml,
        baseVersion,
        now: ctx.deps.now(),
      }),
      "Draw.io diagram",
    );
    if (!result.ok) return conflict(result.conflict.version);
    return {
      ...drawioWritten(
        ctx,
        result.diagram,
        xml === undefined || xml !== written?.xml
          ? await readDrawio(result.diagram.xml)
          : written.model,
        notes,
      ),
      theme: effectiveThemeBrief(
        await DiagramThemes.effectiveDiagramTheme(ctx.deps.db, diagramId),
      ),
    };
  },

  prepare_drawio_upload: async (args, ctx) => {
    let tool: "create_drawio" | "update_drawio";
    let stored: Args;
    if (args.diagramId != null) {
      const diagramId = drawioIdArg(args);
      const title = optionalString(args, "title", MAX_DIAGRAM_TITLE_LENGTH);
      const { baseVersion } = args;
      if (typeof baseVersion !== "number" || !Number.isInteger(baseVersion)) {
        return fail(
          "invalid_argument",
          '"baseVersion" is required with diagramId: pass the integer version read_drawio returned, so a newer save is not overwritten.',
        );
      }
      const { diagram } = await drawioWith(ctx, diagramId, "edit");
      if (diagram.version !== baseVersion) {
        return fail(
          "version_conflict",
          "The diagram changed since you read it. Read it again with read_drawio {downloadLink: true} and redo your change.",
          { currentVersion: diagram.version, url: drawioUrl(ctx, diagramId) },
        );
      }
      tool = "update_drawio";
      stored = { diagramId, baseVersion, ...(title === undefined ? {} : { title }) };
    } else {
      const title = requireString(args, "title", MAX_DIAGRAM_TITLE_LENGTH);
      if (args.applyTheme != null && typeof args.applyTheme !== "boolean") {
        return fail("invalid_argument", '"applyTheme" must be true or false.');
      }
      tool = "create_drawio";
      stored = { title };
      for (const key of ["projectKey", "projectName", "projectId", "applyTheme"]) {
        if (args[key] != null) stored[key] = args[key];
      }
    }
    const link = await drawioLinkFor(ctx, tool, stored);
    const uploadUrl = `${ctx.origin}/api/diagram-uploads/${link.token}`;
    return {
      uploadUrl,
      method: "PUT",
      runs: tool,
      expiresAt: link.expiresAt,
      maxBytes: MAX_DIAGRAM_XML_BYTES,
      curl: `curl -sS -X PUT -H 'Content-Type: application/xml' --data-binary @<file.drawio> '${uploadUrl}'`,
      next: `Send the file with the curl command. The reply is what ${tool} returns (HTTP 200 or 201), or its error as JSON with nothing saved; a refused file leaves the link usable until it expires.`,
    };
  },

  list_diagram_themes: async (_args, ctx) => {
    const list = await DiagramThemes.listDiagramThemes(ctx.deps.db);
    return {
      themes: list.themes.map(themeListing),
      defaultThemeId: list.defaultThemeId,
      roleColours: ROLE_COLOUR_FORMAT,
    };
  },

  set_diagram_theme: async (args, ctx) => {
    const { db } = ctx.deps;
    const { userId } = ctx.principal;
    if (!Object.hasOwn(args, "themeId") || (args.themeId !== null && !isDiagramThemeId(args.themeId))) {
      fail(
        "invalid_argument",
        '"themeId" must be a themeId from list_diagram_themes, or null to follow the default.',
      );
    }
    const themeId = args.themeId as string | null;
    if (args.restyle != null && typeof args.restyle !== "boolean") {
      fail("invalid_argument", '"restyle" must be true or false.');
    }
    const forProject = args.projectId != null || args.projectKey != null;
    if (forProject === (args.diagramId != null)) {
      fail("invalid_argument", 'Pass "diagramId", or "projectKey" or "projectId" for a project\'s default, not both.');
    }
    const usable = async (id: string) => {
      try {
        return await DiagramThemes.requireUsableDiagramTheme(db, { themeId: id });
      } catch (cause) {
        if (cause instanceof Docs.NotFoundError) {
          return fail("not_found", "No theme with that id. list_diagram_themes lists them.");
        }
        throw cause;
      }
    };

    if (forProject) {
      if (args.restyle === true) {
        fail("invalid_argument", '"restyle" restyles one diagram: pass it with "diagramId".');
      }
      const project = await existingProject(ctx, args);
      if (!Access.isAdmin(userId)) {
        fail("forbidden", "Only the workspace admin sets a project's default diagram theme. set_diagram_theme {diagramId, themeId} sets one diagram's.");
      }
      if (themeId !== null) await usable(themeId);
      await DiagramThemes.setProjectDiagramTheme(db, { projectId: project.id, themeId });
      return {
        projectId: project.id,
        theme: effectiveThemeBrief(await DiagramThemes.effectiveProjectTheme(db, project.id)),
        note: "New diagrams in the project start with this theme; diagrams with a theme of their own keep it. No drawing was changed.",
      };
    }

    const diagramId = drawioIdArg(args);
    const { diagram } = await drawioWith(ctx, diagramId, "edit");
    if (themeId !== null) await usable(themeId);
    await DiagramThemes.setDiagramTheme(db, { diagramId, themeId });
    const effective = await DiagramThemes.effectiveDiagramTheme(db, diagramId);
    const theme = effectiveThemeBrief(effective);
    if (args.restyle !== true) {
      return {
        diagramId,
        version: diagram.version,
        theme,
        note: 'No drawing was changed. Pass restyle: true to restyle it to the theme, or write new cells with theme.styleGuide.',
      };
    }
    // As the REST restyle: every custom theme, so boxes in any of their roles keep the role.
    const { themes } = await DiagramThemes.listDiagramThemes(db);
    const result = await DiagramThemes.restyleStoredDiagram(db, {
      diagram,
      theme: effective.theme,
      knownThemes: themes.filter((each) => !each.builtIn),
      baseVersion: diagram.version,
      now: ctx.deps.now(),
    });
    if (!result.ok) {
      if ("invalidXml" in result) {
        fail("invalid_xml", `The theme is set, but the diagram's XML could not be read to restyle it: ${result.invalidXml}.`);
      }
      fail(
        "version_conflict",
        "The theme is set, but someone saved the diagram while it was being restyled. Call set_diagram_theme again with restyle: true.",
        { currentVersion: result.conflict.version },
      );
    }
    return {
      diagramId,
      version: result.diagram.version,
      theme,
      restyle: result.summary,
      note:
        result.summary.changed === 0
          ? "Already in the theme: nothing changed, so the version is the same."
          : `Restyled ${result.summary.changed} cells and saved them as version ${result.diagram.version}. Its picture is redrawn the next time someone opens it or a doc that links it.`,
    };
  },

  prepare_claude_doc_push: async (args, ctx) => {
    const tab = await tabWith(ctx, requireString(args, "tabId"), "editor");
    const claudeDocId = requireString(args, "claudeDocId");
    const tabName = optionalString(args, "tabName", 255);
    const order = optionalString(args, "order", 64);
    const link = await Docs.getClaudeDocLink(ctx.deps.db, tab.id, claudeDocId);
    try {
      return await prepareClaudeDocPush({
        tab,
        claudeDocId,
        link,
        origin: ctx.origin,
        ...(tabName === undefined ? {} : { tabName }),
        ...(order === undefined ? {} : { order }),
      });
    } catch (cause) {
      if (cause instanceof ClaudeDocPushError)
        return fail(cause.code, cause.message);
      throw cause;
    }
  },

  record_claude_doc_push: async (args, ctx) => {
    const tab = await tabWith(ctx, requireString(args, "tabId"), "editor");
    const claudeDocUrl = requireString(args, "claudeDocUrl", 2000);
    if (!/^https:\/\//i.test(claudeDocUrl)) {
      fail("invalid_argument", '"claudeDocUrl" must be an https link.');
    }
    const link = await Docs.saveClaudeDocLink(ctx.deps.db, tab.id, {
      claudeDocId: requireString(args, "claudeDocId"),
      claudeDocUrl,
      claudeTabId: requireString(args, "claudeTabId"),
      claudeBodyId: requireString(args, "claudeBodyId"),
      widgetMap: widgetMapArg(args),
      pushedVersion: requireVersion(args, "pushedVersion"),
      pushedRev: requireVersion(args, "pushedRev"),
      pushedAt: new Date(ctx.deps.now()).toISOString(),
    });
    return { ok: true, link };
  },

  create_sheet: async (args, ctx) => {
    const title =
      optionalString(args, "title", MAX_SHEET_TITLE_LENGTH) ??
      DEFAULT_SHEET_TITLE;
    const projectId = await targetProject(ctx, args);
    const { sheet, records } = await load(
      Sheets.createSheet(ctx.deps.db, {
        projectId,
        title,
        createdBy: ctx.principal.userId,
        now: ctx.deps.now(),
      }),
      "project",
    );
    return {
      ...sheetRead(ctx, sheet, workbookFromRecords(records)),
      ...SHEET_GUIDE,
    };
  },

  list_sheets: async (args, ctx) => {
    const projectId =
      args.noProject === true
        ? null
        : args.projectId != null || args.projectKey != null
          ? (await existingProject(ctx, args)).id
          : undefined;
    const sheets = await Sheets.listSheets(ctx.deps.db, {
      userId: ctx.principal.userId,
      projectId,
    });
    return { sheets: sheets.map((sheet) => sheetSummary(ctx, sheet)) };
  },

  read_sheet: async (args, ctx) => {
    const sheetId = sheetIdArg(args);
    await sheetWith(ctx, sheetId);
    const { sheet, workbook } = await loadWorkbook(ctx, sheetId);
    return sheetRead(ctx, sheet, workbook);
  },

  read_cells: async (args, ctx) => {
    const sheetId = sheetIdArg(args);
    const tab = requireString(args, "sheet", 200);
    const range = requireString(args, "range", 100);
    await sheetWith(ctx, sheetId);
    const { workbook } = await loadWorkbook(ctx, sheetId);
    const read = readCells(workbook, tab, range);
    if (isRefusal(read)) readRefused(workbook, tab, range, read);
    return {
      sheetId,
      revision: workbook.revision,
      sheet: read.sheet,
      tabId: read.sheetId,
      range: read.range,
      rows: read.rows,
    };
  },

  edit_sheet: async (args, ctx) => {
    const sheetId = sheetIdArg(args);
    const { base, edits } = args;
    if (typeof base !== "number" || !Number.isInteger(base) || base < 0) {
      fail(
        "invalid_argument",
        '"base" must be the revision you last read (an integer, 0 or more).',
      );
    }
    if (
      !Array.isArray(edits) ||
      edits.length === 0 ||
      edits.length > MAX_EDITS_PER_LIST ||
      edits.some((edit) => !edit || typeof edit !== "object" || Array.isArray(edit))
    ) {
      fail(
        "invalid_argument",
        `"edits" must be a list of 1 to ${MAX_EDITS_PER_LIST} edit objects, each with a "kind".`,
        SHEET_GUIDE,
      );
    }
    await sheetWith(ctx, sheetId);
    const result = await Sheets.applySheetEdits(ctx.deps.sheetRooms, sheetId, {
      base,
      edits: edits as ReadonlyArray<Edit>,
      origin: null,
      by: await Sheets.sheetAuthor(ctx.deps.db, ctx.principal),
    });
    if (!result.ok) editsRefused(result.refusal, result.revision);
    return { sheetId, revision: result.revision };
  },

  update_sheet: async (args, ctx) => {
    const sheetId = sheetIdArg(args);
    const title = optionalString(args, "title", MAX_SHEET_TITLE_LENGTH);
    await sheetWith(ctx, sheetId);
    const projectId = await sheetMoveTarget(ctx, args);
    if (title === undefined && projectId === undefined) {
      fail(
        "invalid_argument",
        'Pass "title", a project ("projectId" or "projectKey"), or "noProject": true.',
      );
    }
    const sheet = await ctx.deps.sheetRooms.updateMeta(sheetId, {
      title,
      projectId,
      origin: null,
    });
    return sheetSummary(ctx, sheet);
  },
};

export function callTool(
  name: string,
  args: Args,
  ctx: ToolContext,
): Promise<object> {
  if (!Object.hasOwn(handlers, name)) {
    throw new McpToolError(
      { error: "unknown_tool", message: `Unknown tool: ${name}` },
      true,
    );
  }
  return handlers[name as ToolName](args, ctx);
}
