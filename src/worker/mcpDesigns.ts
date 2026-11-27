// The MCP tools for designs (OpenPencil files). Owner: S3. Reads work from the
// last saved copy; edits run OpenPencil's own tools in the editor open in the
// user's browser, through the design's room (designAgent.ts, designRoom.ts),
// so the canvas changes in front of them and their Undo stays theirs. With no
// editor open, edit tools answer `not_open` with the design's link.

import { isAdmin } from "../shared/access.ts";
import {
  DEFAULT_DESIGN_TITLE,
  designPicturePath,
  designUrl,
  isDesignId,
  MAX_DESIGN_TITLE_LENGTH,
  type DesignSummary,
} from "../shared/design.ts";
import type { DesignBridgeAnswer, DesignBridgeCommand } from "./designBridge.ts";
import {
  DESIGN_TOOL_CATEGORIES,
  forwardDesignCommand,
  type DesignAgentPort,
  type DesignToolDef,
} from "./designAgent.ts";
import * as Designs from "./designs.ts";
import { NotFoundError } from "./docs.ts";
import { fail, toBase64, ToolResultWithImages, type ToolImage } from "./mcpResult.ts";
import type { ToolContext } from "./mcpTools.ts";

type Args = Record<string, unknown>;

/** One run_design_tools call runs at most this many tools. */
export const MAX_DESIGN_CALLS = 50;
/** design_tools hands out at most this many full schemas at once. */
const MAX_SCHEMAS = 30;
/** A tool result longer than this (as JSON) is cut, so one call cannot flood the reply. */
const MAX_RESULT_CHARS = 20_000;
/** Pictures bigger than this are not attached: clients refuse images of several megabytes. */
const MAX_ATTACHED_BYTES = 3 * 1024 * 1024;
/** read_doc describes this many linked designs. */
const DOC_DESIGN_LIMIT = 12;
/** An SVG export longer than this is cut. */
const MAX_SVG_CHARS = 200_000;

const DESIGN_GUIDE = { guide: 'format_guide {topic: "design"} has the workflow and examples.' };

const DESIGN_ID_PROP = {
  type: "string",
  description: "The design's id (from list_designs or create_design), or its link.",
} as const;

export const DESIGN_TOOLS = [
  {
    name: "list_designs",
    description:
      "List the designs you are on (OpenPencil files: UI screens, mockups, landing page layouts; every design for the workspace admin), most recently changed first, each with its link, picture link and whether an editor has it open. Narrow to one project with projectId or projectKey, or pass noProject: true.",
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
    name: "create_design",
    description:
      'Use when the user asks for a design, mockup, UI screen or landing page layout (a diagram goes to create_drawio). Creates an empty design and returns its link. Ask the user to open the link: you draw in the open editor with run_design_tools (format_guide {topic: "design"} first). File it like create_doc: projectKey (with projectName if new) or projectId; omit both for no project.',
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        projectId: { type: "string" },
        projectKey: { type: "string" },
        projectName: { type: "string" },
      },
    },
  },
  {
    name: "read_design",
    description:
      "Read one design: title, link, version, whether an editor has it open, and its last saved picture attached as a PNG. While it is open, also its pages, the current page's layer tree (ids, types, names, sizes, texts) and the user's selection. With no editor open, only the saved copy can be read.",
    inputSchema: {
      type: "object",
      properties: {
        designId: DESIGN_ID_PROP,
        depth: {
          type: "integer",
          minimum: 1,
          description: "Levels of the layer tree to return (default 4).",
        },
      },
      required: ["designId"],
    },
  },
  {
    name: "design_tools",
    description: `The OpenPencil tools run_design_tools can run, by category (${DESIGN_TOOL_CATEGORIES.join(", ")}): each with one line. Pass names for their full input schemas (up to ${MAX_SCHEMAS}), or filter (a word in the name or description) and category to narrow the list.`,
    inputSchema: {
      type: "object",
      properties: {
        names: { type: "array", items: { type: "string" }, maxItems: MAX_SCHEMAS },
        filter: { type: "string" },
        category: { type: "string", enum: [...DESIGN_TOOL_CATEGORIES] },
      },
    },
  },
  {
    name: "run_design_tools",
    description: `Run OpenPencil tools in the design open in the user's browser, in order, in one round trip: up to ${MAX_DESIGN_CALLS} calls of {name, args} (names and schemas from design_tools). Stops at the first error; each call's result comes back. The user watches the canvas change, and autosave stores it. Answers not_open, with the link to hand the user, when no editor has the design open.`,
    inputSchema: {
      type: "object",
      properties: {
        designId: DESIGN_ID_PROP,
        calls: {
          type: "array",
          minItems: 1,
          maxItems: MAX_DESIGN_CALLS,
          items: {
            type: "object",
            properties: { name: { type: "string" }, args: { type: "object" } },
            required: ["name"],
          },
        },
      },
      required: ["designId", "calls"],
    },
  },
  {
    name: "undo_design",
    description:
      "Undo your own last changes in the open design (only changes made through these tools; the user's own edits are never undone here), or redo them with redo: true. steps: how many (default 1, up to 20). Stops at the first change the user made.",
    inputSchema: {
      type: "object",
      properties: {
        designId: DESIGN_ID_PROP,
        steps: { type: "integer", minimum: 1, maximum: 20 },
        redo: { type: "boolean" },
      },
      required: ["designId"],
    },
  },
  {
    name: "export_design",
    description:
      "A picture of the design. While it is open: a PNG (attached) or SVG (as text) of the given layers (nodeIds) or of the whole current page. With no editor open: the last saved PNG picture of the page.",
    inputSchema: {
      type: "object",
      properties: {
        designId: DESIGN_ID_PROP,
        format: { type: "string", enum: ["png", "svg"] },
        nodeIds: { type: "array", items: { type: "string" }, maxItems: 100 },
        scale: { type: "number", minimum: 0.1, maximum: 4 },
      },
      required: ["designId"],
    },
  },
] as const;

export type DesignToolName = (typeof DESIGN_TOOLS)[number]["name"];

// ---- arguments and access ----

function designIdArg(args: Args): string {
  const value = args.designId;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (isDesignId(trimmed)) return trimmed;
    const linked = /\/designs\/([A-Za-z0-9_-]{1,64})(?:[/?#]|$)/.exec(trimmed)?.[1];
    if (linked) return linked;
  }
  return fail(
    "invalid_argument",
    '"designId" must be a design\'s id, or its link (<origin>/designs/<id>).',
  );
}

function titleArg(args: Args): string {
  const value = args.title;
  if (value === undefined || value === null) return DEFAULT_DESIGN_TITLE;
  if (typeof value !== "string" || !value.trim() || value.length > MAX_DESIGN_TITLE_LENGTH) {
    return fail(
      "invalid_argument",
      `"title" must be a non-empty string up to ${MAX_DESIGN_TITLE_LENGTH} characters.`,
    );
  }
  return value.trim();
}

async function designWith(ctx: ToolContext, designId: string, need: Designs.DesignNeed) {
  try {
    return await Designs.requireDesign(ctx.deps.db, {
      designId,
      userId: ctx.principal.userId,
      need,
    });
  } catch (cause) {
    if (cause instanceof NotFoundError) {
      return fail("not_found", "No design with that id that you can see.");
    }
    if (cause instanceof Designs.DesignForbiddenError) {
      return fail("forbidden", `Your role on this design does not allow this (needs ${cause.required}).`);
    }
    throw cause;
  }
}

function port(ctx: ToolContext): DesignAgentPort {
  return (
    ctx.designs ??
    fail("unavailable", "The live design bridge is not available on this endpoint.")
  );
}

const urlOf = (ctx: ToolContext, designId: string) => designUrl(ctx.origin, designId);

function summary(ctx: ToolContext, design: DesignSummary) {
  return {
    designId: design.id,
    title: design.title,
    url: urlOf(ctx, design.id),
    projectId: design.projectId,
    version: design.version,
    pictureUrl:
      design.pictureVersion === null
        ? null
        : `${ctx.origin}${designPicturePath(design.id, design.pictureVersion)}`,
    updatedAt: new Date(design.updatedAt).toISOString(),
  };
}

async function isOpen(ctx: ToolContext, designId: string): Promise<boolean> {
  if (!ctx.designs) return false;
  return (await ctx.designs.room(designId).status()).connected;
}

/** The editor's result for one command, or a tool error saying why there is none. */
async function bridge(
  ctx: ToolContext,
  designId: string,
  command: DesignBridgeCommand,
  args: Args,
): Promise<unknown> {
  const answer = await forwardDesignCommand(port(ctx), designId, command, args);
  if (answer.kind === "answer" && answer.ok) return answer.result;
  return bridgeFailure(ctx, designId, answer);
}

interface Failure {
  readonly error: string;
  readonly message: string;
  readonly extra?: Record<string, unknown>;
}

/** Why a command has no result, written for the agent. */
function failureOf(ctx: ToolContext, designId: string, answer: DesignBridgeAnswer): Failure {
  switch (answer.kind) {
    case "not_open":
      return {
        error: "not_open",
        message: `No editor has this design open, and changes run in the open editor. Ask the user to open ${urlOf(ctx, designId)} (in T3 Code's Docs panel or a browser tab), then try again. read_design and export_design still work from the last saved copy.`,
        extra: { url: urlOf(ctx, designId) },
      };
    case "timeout":
      return {
        error: "editor_timeout",
        message:
          "The editor did not answer within 20 seconds; the call was cancelled. It may still have run: read_design shows the current state.",
      };
    case "closed":
      return {
        error: "editor_closed",
        message:
          "The editor closed or reloaded before it answered. It may have run: once it is open again, read_design shows the current state.",
        extra: { url: urlOf(ctx, designId) },
      };
    case "editor_changed":
      return {
        error: "editor_changed",
        message:
          "Another editor took the design over (a tab opened or reloaded), so this call was not sent. read_design shows the current state.",
        extra: { url: urlOf(ctx, designId) },
      };
    case "refused":
      return { error: "not_allowed", message: answer.error, extra: DESIGN_GUIDE };
    case "answer":
      return { error: "editor_error", message: answer.ok ? "Unexpected answer." : answer.error };
  }
}

function bridgeFailure(ctx: ToolContext, designId: string, answer: DesignBridgeAnswer): never {
  const { error, message, extra } = failureOf(ctx, designId, answer);
  return fail(error, message, extra);
}

const notOpen = (ctx: ToolContext, designId: string): never =>
  bridgeFailure(ctx, designId, { kind: "not_open" });

/** A tool's answer that reports a failure in its result, as OpenPencil's atomic tools do. */
const resultError = (result: unknown): string | null => {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const error = (result as Record<string, unknown>).error;
  return typeof error === "string" ? error : error === undefined ? null : JSON.stringify(error);
};

/** Pulls an image out of a result ({base64 | data, mimeType}) so it can be attached. */
function takeImage(result: unknown): { result: unknown; image: ToolImage | null } {
  if (!result || typeof result !== "object" || Array.isArray(result)) return { result, image: null };
  const fields = result as Record<string, unknown>;
  const data = typeof fields.base64 === "string" ? fields.base64 : fields.data;
  const mimeType = fields.mimeType;
  if (typeof data !== "string" || typeof mimeType !== "string" || !mimeType.startsWith("image/")) {
    return { result, image: null };
  }
  const { base64: _base64, data: _data, ...rest } = fields;
  if (data.length * 0.75 > MAX_ATTACHED_BYTES) {
    return { result: { ...rest, image: "Too large to attach: export a smaller scale." }, image: null };
  }
  return { result: { ...rest, image: "Attached after this text." }, image: { data, mimeType } };
}

/** A result small enough for the reply, or its start with a note. */
function capped(result: unknown): unknown {
  const text = JSON.stringify(result) ?? "null";
  if (text.length <= MAX_RESULT_CHARS) return result;
  return {
    truncated: `The result was ${text.length} characters; the first ${MAX_RESULT_CHARS} follow. Ask for less (a depth, root_id or ids).`,
    start: text.slice(0, MAX_RESULT_CHARS),
  };
}

const withImages = (body: object, images: ReadonlyArray<ToolImage>) =>
  images.length > 0 ? new ToolResultWithImages(body, images) : body;

async function savedPicture(
  ctx: ToolContext,
  design: DesignSummary,
): Promise<{ readonly note: string; readonly image: ToolImage | null }> {
  if (design.pictureVersion === null) {
    return { note: "None yet: the editor draws one on its first save.", image: null };
  }
  const picture = await Designs.readDesignPicture(ctx.deps.db, ctx.deps.images, {
    designId: design.id,
    version: design.pictureVersion,
  });
  if (!picture) return { note: "The saved picture is missing.", image: null };
  const bytes = new Uint8Array(await new Response(picture.body).arrayBuffer());
  if (bytes.byteLength > MAX_ATTACHED_BYTES) {
    return { note: "The saved picture is too large to attach.", image: null };
  }
  const stale = design.pictureVersion !== design.version;
  return {
    note: `Attached after this text: the PNG saved with version ${design.pictureVersion}${stale ? ` (the file is at version ${design.version})` : ""}, the page that was on screen.`,
    image: { data: toBase64(bytes), mimeType: "image/png" },
  };
}

// ---- the tools ----

export async function listDesignsTool(ctx: ToolContext, projectId: string | null | undefined) {
  const designs = await Designs.listDesigns(ctx.deps.db, {
    userId: ctx.principal.userId,
    projectId,
  });
  const open = await Promise.all(designs.map((design) => isOpen(ctx, design.id)));
  return {
    designs: designs.map((design, index) => ({
      ...summary(ctx, design),
      role: design.role,
      open: open[index],
    })),
  };
}

export async function createDesignTool(ctx: ToolContext, args: Args, projectId: string | null) {
  const title = titleArg(args);
  const design = await Designs.createDesign(ctx.deps.db, {
    projectId,
    title,
    createdBy: ctx.principal.userId,
    now: ctx.deps.now(),
  });
  return {
    ...summary(ctx, design),
    block: designBlock(design.id),
    next: `Give the user the link and ask them to open it: edits run in the open editor. Then call design_tools and run_design_tools (format_guide {topic: "design"}). To show it in a doc, paste \`block\`.`,
  };
}

export const designBlock = (designId: string) => `\`\`\`t3-design\n${designId}\n\`\`\``;

export async function readDesignTool(ctx: ToolContext, args: Args) {
  const designId = designIdArg(args);
  const depth = args.depth;
  if (depth !== undefined && (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1)) {
    fail("invalid_argument", '"depth" must be an integer, 1 or more.');
  }
  const { design, role } = await designWith(ctx, designId, "view");
  const [picture, open] = await Promise.all([savedPicture(ctx, design), isOpen(ctx, designId)]);
  const body: Record<string, unknown> = {
    ...summary(ctx, design),
    role,
    canEdit: role === "owner" || role === "editor" || isAdmin(ctx.principal.userId),
    open,
    picture: picture.note,
  };
  if (open) {
    try {
      const [pages, tree, selection] = [
        await bridge(ctx, designId, "tool", { name: "list_pages", args: {} }),
        await bridge(ctx, designId, "tool", {
          name: "get_page_tree",
          args: { depth: typeof depth === "number" ? depth : 4 },
        }),
        await bridge(ctx, designId, "selection", {}),
      ];
      body.pages = capped(pages);
      body.layers = capped(tree);
      body.selection = capped(selection);
    } catch (cause) {
      // The editor went away mid-read: the saved copy still answers.
      body.open = false;
      body.live = cause instanceof Error ? cause.message : "The editor did not answer.";
    }
  } else {
    body.live = `No editor has it open, so this is the last saved copy. Edits need it open: ${urlOf(ctx, designId)}`;
  }
  return withImages(body, picture.image ? [picture.image] : []);
}

const firstSentence = (text: string) => {
  const end = text.search(/\.(\s|$)/);
  return (end === -1 ? text : text.slice(0, end + 1)).slice(0, 240);
};

export async function designToolsTool(ctx: ToolContext, args: Args) {
  const bridgePort = port(ctx);
  const tools = await bridgePort.tools();
  const hiddenNote = bridgePort.isolatedEditor
    ? {}
    : {
        note: "render, replace_node and apply_patch (JSX) are off here: this install serves the editor on the app's own origin. Build with create_shape, set_* and the other tools.",
      };
  const { names, filter, category } = args;
  if (names !== undefined) {
    if (
      !Array.isArray(names) ||
      names.length === 0 ||
      names.length > MAX_SCHEMAS ||
      names.some((name) => typeof name !== "string")
    ) {
      fail("invalid_argument", `"names" must be a list of 1 to ${MAX_SCHEMAS} tool names.`);
    }
    const asked = names as ReadonlyArray<string>;
    const found = asked.flatMap((name) => {
      const tool = tools.get(name);
      return tool ? [full(tool)] : [];
    });
    const unknown = asked.filter((name) => !tools.has(name));
    return { tools: found, ...(unknown.length > 0 ? { unknown } : {}), ...hiddenNote };
  }
  if (filter !== undefined && (typeof filter !== "string" || filter.length > 100)) {
    fail("invalid_argument", '"filter" must be a word or two.');
  }
  if (category !== undefined && !(DESIGN_TOOL_CATEGORIES as ReadonlyArray<unknown>).includes(category)) {
    fail("invalid_argument", `"category" must be one of: ${DESIGN_TOOL_CATEGORIES.join(", ")}.`);
  }
  const needle = typeof filter === "string" ? filter.trim().toLowerCase() : "";
  const categories: Record<string, Array<object>> = {};
  for (const tool of tools.values()) {
    if (category !== undefined && tool.category !== category) continue;
    if (needle && !`${tool.name} ${tool.description}`.toLowerCase().includes(needle)) continue;
    (categories[tool.category] ??= []).push({
      name: tool.name,
      description: firstSentence(tool.description),
      ...(tool.mutates ? { changes: true } : {}),
    });
  }
  return {
    categories,
    next: "Pass names for the full input schemas of the tools you will call, then run them with run_design_tools.",
    ...hiddenNote,
  };
}

const full = (tool: DesignToolDef) => ({
  name: tool.name,
  category: tool.category,
  changes: tool.mutates,
  description: tool.description,
  inputSchema: tool.inputSchema,
});

interface Call {
  readonly name: string;
  readonly args: Args;
}

function callsArg(args: Args): ReadonlyArray<Call> {
  const calls = args.calls;
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > MAX_DESIGN_CALLS) {
    return fail(
      "invalid_argument",
      `"calls" must be a list of 1 to ${MAX_DESIGN_CALLS} {name, args} objects.`,
      DESIGN_GUIDE,
    );
  }
  return calls.map((call: unknown, index) => {
    const fields = call && typeof call === "object" ? (call as Record<string, unknown>) : null;
    const callArgs = fields?.args ?? {};
    if (
      typeof fields?.name !== "string" ||
      !callArgs ||
      typeof callArgs !== "object" ||
      Array.isArray(callArgs)
    ) {
      return fail(
        "invalid_argument",
        `Call ${index + 1} must be {name: string, args?: object}.`,
        DESIGN_GUIDE,
      );
    }
    return { name: fields.name, args: callArgs as Args };
  });
}

export async function runDesignToolsTool(ctx: ToolContext, args: Args) {
  const designId = designIdArg(args);
  const calls = callsArg(args);
  const bridgePort = port(ctx);
  const tools = await bridgePort.tools();
  const unknown = [...new Set(calls.map((call) => call.name).filter((name) => !tools.has(name)))];
  if (unknown.length > 0) {
    fail(
      "not_allowed",
      `Not tools you can run here: ${unknown.join(", ")}. Nothing ran. design_tools lists the ones you can.`,
      { unknown, ...DESIGN_GUIDE },
    );
  }
  const changes = calls.some((call) => tools.get(call.name)!.mutates);
  await designWith(ctx, designId, changes ? "edit" : "view");
  if (!(await isOpen(ctx, designId))) notOpen(ctx, designId);

  const results: Array<Record<string, unknown>> = [];
  const images: Array<ToolImage> = [];
  /** The editor connection the batch runs in: one canvas, start to end. */
  let editor: string | null = null;
  for (const [index, call] of calls.entries()) {
    const answer = await forwardDesignCommand(
      bridgePort,
      designId,
      "tool",
      { name: call.name, args: call.args },
      editor,
    );
    if (answer.kind === "answer") editor ??= answer.editor;
    const failure =
      answer.kind === "answer"
        ? answer.ok
          ? resultError(answer.result)
          : answer.error
        : null;
    if (answer.kind !== "answer" || failure !== null) {
      const ran = results.length;
      const own: Failure =
        answer.kind === "answer"
          ? {
              error: "tool_failed",
              message: `${failure}. Its change, if any, was rolled back.`,
              extra: DESIGN_GUIDE,
            }
          : failureOf(ctx, designId, answer);
      fail(
        own.error,
        `Call ${index + 1} (${call.name}) failed: ${own.message} The ${ran} call(s) before it ran and stay; the ones after did not run.`,
        { ...own.extra, ran, results, failedAt: index, failedCall: call.name },
      );
    }
    const { result, image } = takeImage(answer.ok ? answer.result : null);
    if (image) images.push(image);
    results.push({ name: call.name, result: capped(result) });
  }
  return withImages(
    {
      designId,
      ran: results.length,
      results,
      ...(changes
        ? {
            next: "The user sees the changes now; autosave stores them within a few seconds. undo_design reverts your changes; export_design shows the result.",
          }
        : {}),
    },
    images,
  );
}

export async function undoDesignTool(ctx: ToolContext, args: Args) {
  const designId = designIdArg(args);
  const steps = args.steps ?? 1;
  if (typeof steps !== "number" || !Number.isInteger(steps) || steps < 1 || steps > 20) {
    fail("invalid_argument", '"steps" must be an integer from 1 to 20.');
  }
  const command = args.redo === true ? "redo" : "undo";
  await designWith(ctx, designId, "edit");
  if (!(await isOpen(ctx, designId))) notOpen(ctx, designId);
  const done: Array<string> = [];
  let stopped: string | null = null;
  for (let step = 0; step < steps; step += 1) {
    const answer = await forwardDesignCommand(port(ctx), designId, command, {});
    if (answer.kind !== "answer") {
      if (done.length === 0) bridgeFailure(ctx, designId, answer);
      stopped = `The editor stopped answering (${answer.kind}).`;
      break;
    }
    if (!answer.ok) {
      if (done.length === 0) fail(`cannot_${command}`, answer.error);
      stopped = answer.error;
      break;
    }
    const result = answer.result as { applied?: unknown; label?: unknown } | null;
    if (result?.applied !== true) {
      stopped = `Nothing more to ${command}.`;
      break;
    }
    done.push(typeof result.label === "string" ? result.label : command);
  }
  return {
    designId,
    [command === "undo" ? "undone" : "redone"]: done,
    ...(stopped ? { stopped } : {}),
  };
}

export async function exportDesignTool(ctx: ToolContext, args: Args) {
  const designId = designIdArg(args);
  const format = args.format ?? "png";
  if (format !== "png" && format !== "svg") fail("invalid_argument", '"format" must be png or svg.');
  const nodeIds = args.nodeIds;
  if (
    nodeIds !== undefined &&
    (!Array.isArray(nodeIds) ||
      nodeIds.length === 0 ||
      nodeIds.length > 100 ||
      nodeIds.some((id) => typeof id !== "string"))
  ) {
    fail("invalid_argument", '"nodeIds" must be a list of 1 to 100 layer ids.');
  }
  const scale = args.scale;
  if (scale !== undefined && (typeof scale !== "number" || scale < 0.1 || scale > 4)) {
    fail("invalid_argument", '"scale" must be a number from 0.1 to 4.');
  }
  const { design } = await designWith(ctx, designId, "view");
  if (!(await isOpen(ctx, designId))) {
    if (format === "svg" || nodeIds !== undefined) notOpen(ctx, designId);
    const picture = await savedPicture(ctx, design);
    return withImages(
      { ...summary(ctx, design), open: false, picture: picture.note },
      picture.image ? [picture.image] : [],
    );
  }
  const ids = nodeIds as ReadonlyArray<string> | undefined;
  if (format === "svg") {
    const result = await bridge(ctx, designId, "tool", {
      name: "export_svg",
      args: ids ? { ids } : {},
    });
    const failure = resultError(result);
    if (failure) fail("editor_error", failure);
    const fields = (result ?? {}) as Record<string, unknown>;
    const svg = typeof fields.svg === "string" ? fields.svg : typeof result === "string" ? result : null;
    if (svg === null) return { designId, format, result: capped(result) };
    return {
      designId,
      format,
      ...(svg.length > MAX_SVG_CHARS
        ? { svg: svg.slice(0, MAX_SVG_CHARS), truncated: `The SVG is ${svg.length} characters; export fewer layers.` }
        : { svg }),
      ...(fields.warnings ? { warnings: fields.warnings } : {}),
    };
  }
  const result = await bridge(ctx, designId, "export", {
    ...(ids ? { nodeIds: ids } : { scope: "page" }),
    ...(scale === undefined ? {} : { scale }),
    format: "PNG",
  });
  const { image } = takeImage(result);
  if (!image) fail("editor_error", "The editor returned no picture, or one too large to attach (try a smaller scale).");
  return new ToolResultWithImages({ designId, format, picture: "Attached after this text." }, [image]);
}

// ---- designs in docs ----

/** The design ids of a markdown's ```t3-design blocks (the first line of each). */
export function designIdsIn(markdown: string): ReadonlyArray<string> {
  const ids: Array<string> = [];
  const fence = /^(`{3,}|~{3,})t3-design[^\n]*\n([^\n]*)/gm;
  for (const match of markdown.matchAll(fence)) {
    const id = match[2]!.trim();
    if (isDesignId(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The designs `markdowns` show, for read_doc: title, link and picture link of each. */
export async function linkedDesigns(ctx: ToolContext, markdowns: ReadonlyArray<string>) {
  const ids = [...new Set(markdowns.flatMap(designIdsIn))];
  if (ids.length === 0) return {};
  const designs: Array<object> = [];
  for (const designId of ids.slice(0, DOC_DESIGN_LIMIT)) {
    try {
      const { design } = await Designs.requireDesign(ctx.deps.db, {
        designId,
        userId: ctx.principal.userId,
        need: "view",
      });
      const { designId: id, title, url, pictureUrl } = summary(ctx, design);
      designs.push({ designId: id, title, url, pictureUrl });
    } catch (cause) {
      if (!(cause instanceof NotFoundError)) throw cause;
      designs.push({
        designId,
        missing: "No design with this id that you can see, so its block shows as missing.",
      });
    }
  }
  const rest = ids.slice(DOC_DESIGN_LIMIT);
  return {
    designs,
    ...(rest.length > 0
      ? { moreDesigns: { designIds: rest, note: "Shown too: read_design {designId} describes one." } }
      : {}),
  };
}
