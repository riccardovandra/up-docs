// Converts one UP Docs tab into what a Claude Doc tab is made of: a prose body
// in markdown, one widget node per diagram, and embed blocks that place each
// widget in the prose. The worker cannot reach Claude Docs, so an agent carries
// the result there; this module only computes it and never talks to Claude Docs.

import { sha256Hex } from "../../worker/crypto.ts";
import { embedsToLinks, EMBED_LANGUAGE } from "../embeds.ts";
import { splitImageAlt } from "../images.ts";
import { findFences, parseTable, tableToGfm, TABLE_LANGUAGE, type Fence } from "../table.ts";
import { videosToLinks, VIDEO_LANGUAGE } from "../video.ts";
import {
  child,
  childNodes,
  elementName,
  findAttribute,
  literalAttribute,
  parseModule,
  type AstNode,
} from "../widget/ast.ts";
import { findWidgetFences, WIDGET_LANGUAGE } from "../widget/fence.ts";
import { analyzeWidget } from "../widget/validate.ts";

export interface SourceTab {
  readonly id: string;
  readonly docId: string;
  readonly title: string;
  readonly version: number;
  readonly markdown: string;
}

export interface WidgetLink {
  readonly nodeId: string;
  readonly hash: string;
}

/** A tab's last push into one Claude Doc. */
export interface ClaudeDocLink {
  readonly claudeDocId: string;
  readonly claudeDocUrl: string;
  readonly claudeTabId: string;
  readonly claudeBodyId: string;
  readonly widgetMap: Readonly<Record<string, WidgetLink>>;
  readonly pushedVersion: number;
  readonly pushedRev: number;
  readonly pushedAt: string;
}

export interface EmbedBlock {
  readonly type: "embed";
  readonly ref: string;
  readonly caption: string;
}

export interface PushWidget {
  /** The block key in `content.blocks` and the `$lid` of a new node: w1, w2, … in document order. */
  readonly key: string;
  readonly slug: string;
  readonly code: string;
  readonly caption: string;
  readonly hash: string;
  readonly nodeId: string | null;
  readonly changed: boolean;
}

export type WarningKind =
  | "table-flattened"
  | "table-invalid"
  | "video-as-link"
  | "embed-as-link"
  | "mermaid-as-code"
  | "image-dropped"
  | "claude-token-in-text";

export interface PushWarning {
  readonly kind: WarningKind;
  readonly detail: string;
}

export interface PreparedPush {
  readonly mode: "new" | "update";
  readonly tab: {
    readonly tabId: string;
    readonly docId: string;
    readonly title: string;
    readonly version: number;
  };
  readonly link: ClaudeDocLink | null;
  readonly content: {
    readonly markdown: string;
    readonly blocks: Readonly<Record<string, EmbedBlock>>;
  };
  readonly widgets: ReadonlyArray<PushWidget>;
  readonly removedWidgets: ReadonlyArray<{ readonly slug: string; readonly nodeId: string }>;
  readonly warnings: ReadonlyArray<PushWarning>;
  readonly batch?: ReadonlyArray<BatchMember>;
  readonly widgetCreates?: ReadonlyArray<BatchMember>;
}

export type BatchMember = Readonly<Record<string, unknown>>;

/** A tab that cannot be pushed as it stands; the message says what to fix. */
export class ClaudeDocPushError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const DEFAULT_ORDER = "z0";
const MAX_BIRTH_NAME = 255;

/** A short stable hash of a widget's code: SHA-256 hex, first 16 characters. */
export const widgetHash = async (code: string): Promise<string> =>
  (await sha256Hex(code)).slice(0, 16);

/** The tab name as a Claude Docs file name: no slashes or control characters, trimmed, at most 255. */
export function birthName(tabName: string): string {
  const stem = tabName
    .replace(/[/\\\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_BIRTH_NAME)
    .trim();
  return `${stem || "Untitled"}.ldoc`;
}

/** The svg's literal aria-label, else the words of the text with id 'title', else the slug. */
export function widgetCaption(code: string, slug: string): string {
  const parsed = parseModule(code);
  if (parsed.ok) {
    const svg = findFirst(
      parsed.program,
      (node) => node.type === "JSXElement" && elementName(node) === "svg",
    );
    const label = svg ? literalAttribute(findAttribute(svg, "aria-label"))?.trim() : null;
    if (label) return label;
  }
  const title = analyzeWidget(code)
    .labels.find((label) => label.id === "title")
    ?.text.trim();
  return title || slug;
}

function findFirst(node: AstNode, test: (node: AstNode) => boolean): AstNode | null {
  if (test(node)) return node;
  for (const next of childNodes(node)) {
    const found = findFirst(next, test);
    if (found) return found;
  }
  return null;
}

// Uploaded images live under /api/images/; Claude Docs cannot load them.
const DOC_IMAGE =
  /!\[((?:\\.|[^\]\\])*)\]\(\s*<?(?:https?:\/\/[^/\s)]+)?\/api\/images\/[^)\s>]+>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const CLAUDE_TOKEN = /<\?claude/g;

/** Prose outside code blocks: drops uploaded images and escapes Claude Docs block tokens. */
function convertText(text: string, warnings: Array<PushWarning>): string {
  const withoutImages = text.replace(DOC_IMAGE, (_match, rawAlt: string) => {
    const alt = splitImageAlt(rawAlt.replace(/\\(.)/g, "$1")).alt.trim();
    warnings.push({ kind: "image-dropped", detail: alt || "(no alt text)" });
    return `_[image: ${alt.replace(/([\\[\]_*])/g, "\\$1")}]_`;
  });
  const tokens = withoutImages.match(CLAUDE_TOKEN)?.length ?? 0;
  if (tokens > 0) {
    warnings.push({
      kind: "claude-token-in-text",
      detail: `${tokens} literal "<?claude" in the text, escaped as "\\<?claude".`,
    });
  }
  return withoutImages.replace(CLAUDE_TOKEN, "\\<?claude");
}

const lineOf = (markdown: string, offset: number) => markdown.slice(0, offset).split("\n").length;

interface Converted {
  readonly markdown: string;
  readonly widgets: ReadonlyArray<{ key: string; slug: string; code: string; caption: string }>;
  readonly warnings: ReadonlyArray<PushWarning>;
}

/** The tab's markdown in Claude Docs form, with `<?claude block wN?>` where each diagram was. */
export function convertMarkdown(markdown: string, origin: string): Converted {
  const warnings: Array<PushWarning> = [];
  const widgetsByLine = new Map(findWidgetFences(markdown).map((fence) => [fence.line, fence]));
  const widgets: Array<{ key: string; slug: string; code: string; caption: string }> = [];
  const slugs = new Set<string>();
  let out = "";
  let at = 0;

  const block = (fence: Fence, replacement: string) => {
    out += convertText(markdown.slice(at, fence.start), warnings) + replacement;
    at = fence.end;
  };

  for (const fence of findFences(markdown)) {
    const source = markdown.slice(fence.start, fence.end);
    switch (fence.language) {
      case WIDGET_LANGUAGE: {
        const widget = widgetsByLine.get(lineOf(markdown, fence.start));
        if (!widget) break;
        const slug = widget.id;
        if (!slug) {
          throw new ClaudeDocPushError(
            "widget_without_id",
            `The diagram at line ${widget.line} has no id; give it one with edit_tab before pushing.`,
          );
        }
        if (slugs.has(slug)) {
          throw new ClaudeDocPushError(
            "duplicate_widget_id",
            `Two diagrams share the id "${slug}"; rename one with edit_tab before pushing.`,
          );
        }
        slugs.add(slug);
        const key = `w${widgets.length + 1}`;
        widgets.push({
          key,
          slug,
          code: widget.source,
          caption: widgetCaption(widget.source, slug),
        });
        // The token must be a paragraph of its own: a blank line on each side.
        block(fence, "");
        const lead = out === "" || out.endsWith("\n\n") ? "" : out.endsWith("\n") ? "\n" : "\n\n";
        const rest = markdown.slice(at);
        const trail = rest === "" || rest === "\n" || rest.startsWith("\n\n") ? "" : "\n";
        out += `${lead}<?claude block ${key}?>${trail}`;
        break;
      }
      case TABLE_LANGUAGE: {
        const parsed = parseTable(fence.body);
        if (parsed.ok) {
          warnings.push({ kind: "table-flattened", detail: parsed.table.id });
          block(fence, tableToGfm(parsed.table));
        } else {
          warnings.push({ kind: "table-invalid", detail: `Kept as a code block: ${parsed.error}` });
        }
        break;
      }
      case VIDEO_LANGUAGE: {
        const link = videosToLinks(source, origin);
        if (link !== source) {
          warnings.push({ kind: "video-as-link", detail: link });
          block(fence, link);
        }
        break;
      }
      case EMBED_LANGUAGE: {
        const link = embedsToLinks(source);
        if (link !== source) {
          warnings.push({ kind: "embed-as-link", detail: link });
          block(fence, link);
        }
        break;
      }
      case "mermaid":
        warnings.push({
          kind: "mermaid-as-code",
          detail: `Mermaid diagram at line ${lineOf(markdown, fence.start)} kept as a code block.`,
        });
        break;
    }
  }
  out += convertText(markdown.slice(at), warnings);
  return { markdown: out, widgets, warnings };
}

/** The `$lid` reference Claude Docs resolves within one batch. */
const lid = (key: string) => `$lid:${key}`;

/**
 * Every Claude Docs member shape lives here, so a change in what Claude Docs
 * accepts is a change in one place.
 */
export const ClaudeDocMembers = {
  createFile: (name: string): BatchMember => ({
    $lid: "f",
    verb: "create",
    object: "file",
    payload: { value: { birthName: name } },
  }),
  createWidget: (key: string, fileId: string, code: string): BatchMember => ({
    $lid: key,
    verb: "create",
    object: "node",
    engine: "widget",
    payload: { parent: { object: "file", id: fileId }, code },
  }),
  createProse: (
    fileId: string,
    markdown: string,
    blocks: Readonly<Record<string, EmbedBlock>>,
  ): BatchMember => ({
    $lid: "n",
    verb: "create",
    object: "node",
    engine: "prose",
    payload: {
      parent: { object: "file", id: fileId },
      source: {
        as: "markdown",
        ...(Object.keys(blocks).length > 0 ? { blocks } : {}),
        from: { kind: "inline", content: markdown },
      },
    },
  }),
  setFileContent: (fileId: string, name: string, nodeId: string): BatchMember => ({
    verb: "update",
    ref: { object: "file", id: fileId },
    payload: { kind: "value", value: { birthName: name, content: { kind: "node", id: nodeId } } },
  }),
  addTab: (claudeDocId: string, fileId: string, name: string, order: string): BatchMember => ({
    verb: "update",
    ref: { object: "project", id: claudeDocId },
    payload: {
      kind: "patch",
      patch: [{ op: "set", path: ["tabs", fileId], value: { name, order } }],
    },
  }),
};

export interface PrepareInput {
  readonly tab: SourceTab;
  readonly claudeDocId: string;
  readonly tabName?: string;
  readonly order?: string;
  readonly link: ClaudeDocLink | null;
  /** Makes links to uploaded videos absolute. */
  readonly origin: string;
}

/** Everything an agent needs to push `tab` into the Claude Doc, as a new tab or over its last push. */
export async function prepareClaudeDocPush(input: PrepareInput): Promise<PreparedPush> {
  const { tab, link } = input;
  const converted = convertMarkdown(tab.markdown, input.origin);
  const widgets: Array<PushWidget> = [];
  for (const widget of converted.widgets) {
    const hash = await widgetHash(widget.code);
    const linked = link?.widgetMap[widget.slug] ?? null;
    widgets.push({
      ...widget,
      hash,
      nodeId: linked?.nodeId ?? null,
      changed: linked === null || linked.hash !== hash,
    });
  }
  const blocks: Record<string, EmbedBlock> = {};
  for (const widget of widgets) {
    blocks[widget.key] = {
      type: "embed",
      ref: `node/${widget.nodeId ?? lid(widget.key)}`,
      caption: widget.caption,
    };
  }
  const slugs = new Set(widgets.map((widget) => widget.slug));
  const removedWidgets = link
    ? Object.entries(link.widgetMap)
        .filter(([slug]) => !slugs.has(slug))
        .map(([slug, { nodeId }]) => ({ slug, nodeId }))
    : [];

  const common = {
    tab: { tabId: tab.id, docId: tab.docId, title: tab.title, version: tab.version },
    link,
    content: { markdown: converted.markdown, blocks },
    widgets,
    removedWidgets,
    warnings: converted.warnings,
  };

  if (link) {
    return {
      mode: "update",
      ...common,
      widgetCreates: widgets
        .filter((widget) => widget.nodeId === null)
        .map((widget) => ClaudeDocMembers.createWidget(widget.key, link.claudeTabId, widget.code)),
    };
  }

  const tabName = (input.tabName ?? tab.title).trim() || "Untitled";
  const name = birthName(tabName);
  const file = lid("f");
  return {
    mode: "new",
    ...common,
    batch: [
      ClaudeDocMembers.createFile(name),
      ...widgets.map((widget) => ClaudeDocMembers.createWidget(widget.key, file, widget.code)),
      ClaudeDocMembers.createProse(file, converted.markdown, blocks),
      ClaudeDocMembers.setFileContent(file, name, lid("n")),
      ClaudeDocMembers.addTab(input.claudeDocId, file, tabName, input.order ?? DEFAULT_ORDER),
    ],
  };
}
