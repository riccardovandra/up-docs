// Claude's diagram format: one JSX module whose default export draws an <svg>.
// The rules keep every typed label a literal under a literal id, so a person
// can edit its words in place and the rest of the module stays byte-identical.

import {
  type AstNode,
  child,
  childList,
  childNodes,
  cleanJsxText,
  elementAttributes,
  elementName,
  findAttribute,
  jsxName,
  literalAttribute,
  parseModule,
} from "./ast.ts";

export const WIDGET_RULES = [
  "parse",
  "module-shape",
  "svg-root",
  "element",
  "attribute",
  "unknown-component",
  "visualize",
  "text-id",
  "text-literal",
  "segment-literal",
  "colour",
  "eval-family",
  "window-name",
  "deterministic",
  "too-large",
] as const;

export type WidgetRule = (typeof WIDGET_RULES)[number];

export interface WidgetDiagnostic {
  readonly rule: WidgetRule;
  readonly message: string;
  /** 1-based, in the module source. */
  readonly line: number;
  readonly column: number;
}

export interface WidgetLabel {
  readonly id: string;
  /** The words as drawn (JSX whitespace rules applied). */
  readonly text: string;
  readonly element: "text" | "tspan";
  /** Source range of the JSXText holding the words. */
  readonly start: number;
  readonly end: number;
  /** The nearest literal `data-claude-anchor` around the label. */
  readonly anchor: string | null;
}

export interface WidgetAnalysis {
  readonly diagnostics: ReadonlyArray<WidgetDiagnostic>;
  readonly labels: ReadonlyArray<WidgetLabel>;
  /** Literal anchor names; a template written in a loop is listed as written. */
  readonly anchors: ReadonlyArray<string>;
  readonly viewBox: { readonly width: number; readonly height: number } | null;
  /** The words of the first <text>. */
  readonly title: string | null;
}

export const MAX_WIDGET_SOURCE = 100_000;
export const SLUG = /^[A-Za-z0-9_-]{1,64}$/;
export const TEXT_ID_ATTRIBUTE = "data-claude-text-id";
export const ANCHOR_ATTRIBUTE = "data-claude-anchor";
/** Names the compiled module uses; user code may not shadow them. */
export const RESERVED_PREFIX = "__widget";

export const COLOUR_TOKENS = [
  "--cds-text-primary",
  "--cds-text-secondary",
  "--cds-chart-axis",
  "--cds-chart-grid",
  "--cds-chart-reference-tint",
  "--cds-chart-categorical-1",
  "--cds-chart-categorical-2",
  "--cds-chart-categorical-3",
  "--cds-chart-categorical-4",
  "--cds-chart-categorical-5",
  "--cds-chart-categorical-6",
  "--cds-chart-categorical-7",
  "--cds-chart-categorical-8",
  "--cds-chart-status-good",
  "--cds-chart-status-warning",
  "--cds-chart-status-critical",
] as const;

const ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "marker",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "title",
  "desc",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
  "pattern",
]);

/** The browser's names for its window objects: a way out of the widget. */
const WINDOW_NAMES = new Set([
  "top",
  "parent",
  "self",
  "window",
  "globalThis",
  "frames",
  "opener",
  "document",
  "location",
  "frameElement",
]);

const EVAL_NAMES = new Set([
  "eval",
  "Function",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "importScripts",
]);
const CLOCK_NAMES = new Set([
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "performance",
  "crypto",
]);
const COLOUR_ATTRIBUTES = new Set([
  "fill",
  "stroke",
  "stopColor",
  "floodColor",
  "lightingColor",
  "color",
]);
const COLOUR_KEYWORDS = new Set(["none", "transparent", "currentColor", "inherit"]);
const TOKEN_SET = new Set<string>(COLOUR_TOKENS);

const isFunction = (node: AstNode) =>
  node.type === "ArrowFunctionExpression" ||
  node.type === "FunctionExpression" ||
  node.type === "FunctionDeclaration" ||
  node.type === "ObjectMethod" ||
  node.type === "ClassMethod";

const isJsxRoot = (node: AstNode | null): node is AstNode =>
  node?.type === "JSXElement" && elementName(node) === "svg";

function colourProblem(value: string): string | null {
  if (/(?<!url\()#[0-9a-fA-F]{3,8}\b/.test(value)) return "Hex colours are not allowed";
  if (/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/.test(value)) {
    return "Colour functions are not allowed";
  }
  for (const match of value.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)) {
    if (!TOKEN_SET.has(match[1] ?? "")) return `${match[1]} is not a diagram colour token`;
  }
  return null;
}

export function analyzeWidget(source: string): WidgetAnalysis {
  const diagnostics: Array<WidgetDiagnostic> = [];
  const labels: Array<WidgetLabel> = [];
  const anchors: Array<string> = [];
  const empty = { diagnostics, labels, anchors, viewBox: null, title: null };

  if (source.length > MAX_WIDGET_SOURCE) {
    diagnostics.push({
      rule: "too-large",
      message: `The module is over ${MAX_WIDGET_SOURCE} characters.`,
      line: 1,
      column: 1,
    });
    return empty;
  }
  const parsed = parseModule(source);
  if (!parsed.ok) {
    diagnostics.push({
      rule: "parse",
      message: parsed.message,
      line: parsed.line,
      column: parsed.column,
    });
    return empty;
  }

  const report = (rule: WidgetRule, node: AstNode, message: string) => {
    diagnostics.push({
      rule,
      message,
      line: node.loc.start.line,
      column: node.loc.start.column + 1,
    });
  };

  // Module shape: declarations, then one default export of the drawing.
  const components = new Set<string>();
  let drawing: AstNode | null = null;
  for (const statement of childList(parsed.program, "body")) {
    if (statement.type === "ExportDefaultDeclaration") {
      const declaration = child(statement, "declaration");
      if (drawing) {
        report("module-shape", statement, "A module has one default export.");
      } else if (
        declaration &&
        (declaration.type === "ArrowFunctionExpression" ||
          declaration.type === "FunctionExpression" ||
          declaration.type === "FunctionDeclaration")
      ) {
        drawing = declaration;
      } else {
        report(
          "module-shape",
          statement,
          "The default export must be a function that returns <svg>.",
        );
      }
    } else if (
      statement.type === "VariableDeclaration" ||
      statement.type === "FunctionDeclaration"
    ) {
      const declared =
        statement.type === "FunctionDeclaration"
          ? [child(statement, "id")]
          : childList(statement, "declarations").map((declarator) => child(declarator, "id"));
      for (const id of declared) {
        if (id?.type === "Identifier" && /^[A-Z]/.test(String(id.name))) {
          components.add(String(id.name));
        }
      }
    } else if (statement.type !== "EmptyStatement") {
      report(
        "module-shape",
        statement,
        statement.type.startsWith("Import") || statement.type.startsWith("Export")
          ? "Imports and named exports are not allowed; the module is one default export."
          : "Only declarations may sit beside the default export.",
      );
    }
  }
  if (!drawing) {
    if (!diagnostics.some((entry) => entry.rule === "module-shape")) {
      report("module-shape", parsed.program, "Add `export default () => <svg …>…</svg>;`.");
    }
    return empty;
  }

  // The drawing returns one <svg> with a literal viewBox.
  const roots: Array<AstNode> = [];
  const body = child(drawing, "body");
  if (body?.type === "BlockStatement") {
    const collectReturns = (node: AstNode) => {
      for (const next of childNodes(node)) {
        if (isFunction(next)) continue;
        if (next.type === "ReturnStatement") {
          const argument = child(next, "argument");
          if (isJsxRoot(argument)) roots.push(argument);
          else report("svg-root", next, "The drawing must return an <svg> element.");
        } else {
          collectReturns(next);
        }
      }
    };
    collectReturns(body);
    if (roots.length === 0 && !diagnostics.some((entry) => entry.rule === "svg-root")) {
      report("svg-root", drawing, "The drawing must return an <svg> element.");
    }
  } else if (isJsxRoot(body)) {
    roots.push(body);
  } else if (body && elementName(body) === "claude.Visualize") {
    report(
      "visualize",
      body,
      "claude.Visualize data-bound charts are not supported in UP Docs; draw a plain <svg>.",
    );
  } else if (body) {
    report("svg-root", body, "The drawing must return an <svg> element.");
  }
  let viewBox: WidgetAnalysis["viewBox"] = null;
  for (const root of roots) {
    const value = literalAttribute(findAttribute(root, "viewBox"));
    const match = value ? /^\s*0\s+0\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*$/.exec(value) : null;
    const width = Number(match?.[1]);
    const height = Number(match?.[2]);
    if (!match || !(width > 0) || !(height > 0)) {
      report("svg-root", root, "<svg> needs a literal viewBox='0 0 <width> <height>'.");
    } else {
      viewBox ??= { width, height };
    }
  }

  const textIds = new Set<string>();
  let title: string | null = null;
  let sawText = false;

  // Walks with the stack of enclosing functions and anchors.
  const walk = (
    node: AstNode,
    parent: AstNode | null,
    functions: number,
    anchor: string | null,
  ) => {
    switch (node.type) {
      case "Identifier": {
        const name = String(node.name);
        const isKey =
          parent &&
          ((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression"
            ? child(parent, "property") === node && parent.computed !== true
            : false) ||
            ((parent.type === "ObjectProperty" || parent.type === "ObjectMethod") &&
              child(parent, "key") === node &&
              parent.computed !== true &&
              parent.shorthand !== true));
        if (isKey) break;
        if (name.startsWith(RESERVED_PREFIX)) {
          report("module-shape", node, `Names starting with ${RESERVED_PREFIX} are reserved.`);
        } else if (WINDOW_NAMES.has(name)) {
          report(
            "window-name",
            node,
            `\`${name}\` is refused as a name (it is a browser window object); rename it, e.g. a top edge is \`y0\`.`,
          );
        } else if (EVAL_NAMES.has(name)) {
          report("eval-family", node, `\`${name}\` is not available in a diagram.`);
        } else if (CLOCK_NAMES.has(name)) {
          report(
            "deterministic",
            node,
            `\`${name}\` is not allowed: a diagram draws the same every time.`,
          );
        }
        break;
      }
      case "Import":
        report("eval-family", node, "Dynamic import is not available in a diagram.");
        break;
      case "MetaProperty":
        report("eval-family", node, "`import.meta` is not available in a diagram.");
        break;
      case "MemberExpression":
      case "OptionalMemberExpression": {
        const property = child(node, "property");
        if (
          node.computed === true &&
          property?.type !== "NumericLiteral" &&
          property?.type !== "StringLiteral"
        ) {
          report(
            "eval-family",
            node,
            "Computed index: use `.at(i)` or a literal read such as `pos.commit`.",
          );
        }
        const object = child(node, "object");
        if (
          object?.type === "Identifier" &&
          node.computed !== true &&
          ((object.name === "Math" && property?.name === "random") ||
            (object.name === "Date" && property?.name === "now"))
        ) {
          report(
            "deterministic",
            node,
            "No clock or randomness: a diagram draws the same every time.",
          );
        }
        break;
      }
      case "NewExpression":
      case "CallExpression": {
        const callee = child(node, "callee");
        if (
          callee?.type === "Identifier" &&
          callee.name === "Date" &&
          (node.type === "CallExpression" || childList(node, "arguments").length === 0)
        ) {
          report("deterministic", node, "No clock: `new Date()` needs a fixed date.");
        }
        break;
      }
      case "StringLiteral": {
        const problem = colourProblem(String(node.value));
        if (problem) report("colour", node, `${problem}; use var(--cds-…) tokens.`);
        break;
      }
      case "TemplateElement": {
        const raw = (node.value as { raw?: unknown } | undefined)?.raw;
        const problem = typeof raw === "string" ? colourProblem(raw) : null;
        if (problem) report("colour", node, `${problem}; use var(--cds-…) tokens.`);
        break;
      }
      case "JSXElement":
        anchor = checkElement(node, functions, anchor);
        break;
      case "JSXSpreadChild":
        report("text-literal", node, "Spread children are not allowed.");
        break;
    }
    const inner = isFunction(node) && node !== drawing ? functions + 1 : functions;
    for (const next of childNodes(node)) walk(next, node, inner, anchor);
  };

  /** Checks one element; returns the anchor its children sit in. */
  const checkElement = (
    element: AstNode,
    functions: number,
    anchor: string | null,
  ): string | null => {
    const nameNode = child(child(element, "openingElement") ?? element, "name");
    const name = jsxName(nameNode);
    if (nameNode?.type === "JSXMemberExpression") {
      if (name === "claude.Visualize") {
        report(
          "visualize",
          element,
          "claude.Visualize data-bound charts are not supported in UP Docs; draw a plain <svg>.",
        );
      } else {
        report("unknown-component", element, `<${name}> is not a component in this module.`);
      }
    } else if (
      nameNode?.type === "JSXNamespacedName" ||
      (/^[a-z]/.test(name) && !ELEMENTS.has(name))
    ) {
      report("element", element, `<${name}> is not an element widgets may render.`);
    } else if (/^[A-Z]/.test(name) && !components.has(name)) {
      report(
        "unknown-component",
        element,
        `<${name}> must be declared at the top of the module, before export default.`,
      );
    }

    let textId: string | null = null;
    let textIdAttribute: AstNode | null = null;
    for (const attribute of elementAttributes(element)) {
      if (attribute.type !== "JSXAttribute") continue;
      const attributeName = jsxName(child(attribute, "name"));
      if (
        /^on[A-Z]/i.test(attributeName) ||
        attributeName.includes(":") ||
        ["dangerouslySetInnerHTML", "href", "xlinkHref", "style", "ref", "src"].includes(
          attributeName,
        )
      ) {
        report("attribute", attribute, `The attribute ${attributeName} is not allowed.`);
        continue;
      }
      if (attributeName === TEXT_ID_ATTRIBUTE) {
        textIdAttribute = attribute;
        textId = literalAttribute(attribute);
        continue;
      }
      if (attributeName === ANCHOR_ATTRIBUTE) {
        const value = child(attribute, "value");
        const expression =
          value?.type === "JSXExpressionContainer" ? child(value, "expression") : null;
        const literal = literalAttribute(attribute);
        if (literal !== null) {
          if (!SLUG.test(literal)) {
            report(
              "segment-literal",
              attribute,
              "Anchor names are letters, digits, _ and -, at most 64.",
            );
          } else {
            anchors.push(literal);
            anchor = literal;
          }
        } else if (expression?.type === "TemplateLiteral") {
          anchors.push(source.slice(expression.start + 1, expression.end - 1));
          anchor = null;
        } else {
          report(
            "segment-literal",
            attribute,
            "data-claude-anchor must be a string literal, or a template literal in a loop.",
          );
        }
        continue;
      }
      if (COLOUR_ATTRIBUTES.has(attributeName)) {
        const literal = literalAttribute(attribute);
        if (
          literal !== null &&
          colourProblem(literal) === null &&
          !COLOUR_KEYWORDS.has(literal.trim()) &&
          !/^url\(#[^)]+\)$/.test(literal.trim()) &&
          !/^var\(--cds-[a-z0-9-]+\)$/.test(literal.trim())
        ) {
          report(
            "colour",
            attribute,
            `${attributeName}='${literal}' is not a colour token; use var(--cds-…).`,
          );
        }
      }
    }

    const isText = name === "text" || name === "tspan";
    const children = childList(element, "children").filter(
      (entry) =>
        !(
          entry.type === "JSXExpressionContainer" &&
          child(entry, "expression")?.type === "JSXEmptyExpression"
        ),
    );
    const typed = children.filter(
      (entry) => entry.type === "JSXText" && cleanJsxText(String(entry.value)) !== null,
    );

    if (textIdAttribute) {
      if (!isText) {
        report("text-id", textIdAttribute, "Only <text> and <tspan> carry data-claude-text-id.");
      } else if (textId === null) {
        report(
          "text-id",
          textIdAttribute,
          "data-claude-text-id must be a literal string, never computed.",
        );
      } else if (!SLUG.test(textId)) {
        report("text-id", textIdAttribute, "Text ids are letters, digits, _ and -, at most 64.");
      } else if (textIds.has(textId)) {
        report(
          "text-id",
          textIdAttribute,
          `The text id '${textId}' is used twice; each id appears once.`,
        );
      } else if (functions > 0) {
        report(
          "text-id",
          textIdAttribute,
          "Labels are written out in the drawing itself, not inside a loop, helper or component.",
        );
      } else if (children.some((entry) => entry.type === "JSXElement")) {
        report(
          "text-literal",
          textIdAttribute,
          "An id on a <text> that holds <tspan>s: put one id on each <tspan> instead.",
        );
      } else if (children.length !== 1 || typed.length !== 1) {
        report(
          "text-literal",
          textIdAttribute,
          "A label's words must be literal JSX text, never computed.",
        );
      } else {
        textIds.add(textId);
        const words = typed[0]!;
        const text = cleanJsxText(String(words.value))!;
        labels.push({
          id: textId,
          text,
          element: name as "text" | "tspan",
          start: words.start,
          end: words.end,
          anchor,
        });
      }
    } else if (isText && typed.length > 0 && functions === 0) {
      report(
        "text-id",
        element,
        `Typed words need their own data-claude-text-id ('${cleanJsxText(String(typed[0]!.value))?.slice(0, 40)}').`,
      );
    }

    if (name === "text" && !sawText) {
      sawText = true;
      const words = [
        ...typed.map((entry) => cleanJsxText(String(entry.value))),
        ...children
          .filter((entry) => entry.type === "JSXElement" && elementName(entry) === "tspan")
          .flatMap((tspan) => childList(tspan, "children"))
          .filter((entry) => entry.type === "JSXText")
          .map((entry) => cleanJsxText(String(entry.value))),
      ].filter((entry): entry is string => entry !== null);
      title = words.length > 0 ? words.join(" ") : null;
    }
    return anchor;
  };

  walk(parsed.program, null, 0, null);
  diagnostics.sort((a, b) => a.line - b.line || a.column - b.column);
  return { diagnostics, labels, anchors, viewBox, title };
}

export const formatDiagnostic = (diagnostic: WidgetDiagnostic): string =>
  `${diagnostic.line}:${diagnostic.column} ${diagnostic.rule}: ${diagnostic.message}`;
