// Turns a widget module into a plain script by splicing source at AST
// positions: JSX becomes `__widget_h(...)` calls, `export default` an
// assignment, and every function and loop body starts by counting a step.
// Everything else is copied byte for byte.

import {
  type AstNode,
  child,
  childList,
  childNodes,
  cleanJsxText,
  isNode,
  jsxName,
  parseModule,
} from "./ast.ts";

export const WIDGET_H = "__widget_h";
export const WIDGET_FRAGMENT = "__widget_fragment";
export const WIDGET_DRAWING = "__widget_drawing";
export const WIDGET_STEP = "__widget_step";

/**
 * Function calls and loop iterations one render may take. The sandbox can
 * share the page's renderer thread, so a module that never finishes would
 * freeze the doc; the budget turns it into a thrown error, which the sandbox
 * reports as the diagram's error state. Invalid modules still run (their
 * problems are listed beside the drawing), so refusing loops in the validator
 * alone would not stop one, and recursion cannot be refused statically.
 */
export const WIDGET_STEP_BUDGET = 1_000_000;
export const WIDGET_BUDGET_MESSAGE = `The diagram did not finish within ${WIDGET_STEP_BUDGET.toLocaleString("en-US")} steps; it may loop forever.`;

// Once spent, every later step throws too, so a module that catches the error
// is still stopped by its next call or iteration.
const STEP_PRELUDE = `let ${WIDGET_STEP}s = 0; const ${WIDGET_STEP} = () => { if (++${WIDGET_STEP}s > ${WIDGET_STEP_BUDGET}) throw new Error(${JSON.stringify(WIDGET_BUDGET_MESSAGE)}); };\n`;

export type CompileResult =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly message: string };

const isJsx = (node: AstNode) => node.type === "JSXElement" || node.type === "JSXFragment";

const COUNTED = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
  "WhileStatement",
  "DoWhileStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
]);
const isLoop = (node: AstNode) => node.type.endsWith("Statement");

/**
 * The module's body as a script that assigns the drawing to `__widget_drawing`.
 * Run it as `function (__widget_h, __widget_fragment) { let __widget_drawing; …; return __widget_drawing; }`.
 * Validate first: this only rewrites syntax.
 */
export function compileWidget(source: string): CompileResult {
  const parsed = parseModule(source);
  if (!parsed.ok)
    return { ok: false, message: `${parsed.line}:${parsed.column} ${parsed.message}` };

  const rewriteInside = new Map<AstNode, boolean>();
  const needsRewrite = (node: AstNode): boolean => {
    const known = rewriteInside.get(node);
    if (known !== undefined) return known;
    const found = isJsx(node) || COUNTED.has(node.type) || childNodes(node).some(needsRewrite);
    rewriteInside.set(node, found);
    return found;
  };

  /** A function or loop body that counts a step before it runs. */
  const emitCounted = (owner: AstNode, body: AstNode): string => {
    const inner = emit(body);
    if (body.type === "BlockStatement") return `{${WIDGET_STEP}();${inner.slice(1)}`;
    return isLoop(owner) ? `{${WIDGET_STEP}();${inner}}` : `(${WIDGET_STEP}(), ${inner})`;
  };

  /** The node's source with every JSX inside it compiled and every body counted. */
  const emit = (node: AstNode): string => {
    if (isJsx(node)) return emitJsx(node);
    if (!needsRewrite(node)) return source.slice(node.start, node.end);
    const body = COUNTED.has(node.type) ? child(node, "body") : null;
    let out = "";
    let at = node.start;
    for (const next of childNodes(node)) {
      if (next !== body && !needsRewrite(next)) continue;
      out += source.slice(at, next.start) + (next === body ? emitCounted(node, next) : emit(next));
      at = next.end;
    }
    return out + source.slice(at, node.end);
  };

  const emitTag = (name: AstNode | null): string => {
    const written = jsxName(name);
    if (name?.type === "JSXIdentifier" && /^[a-z]/.test(written)) return JSON.stringify(written);
    if (name?.type === "JSXNamespacedName") return JSON.stringify(written);
    return written;
  };

  const emitJsx = (node: AstNode): string => {
    const opening = child(node, "openingElement");
    const tag =
      node.type === "JSXFragment" ? WIDGET_FRAGMENT : emitTag(child(opening ?? node, "name"));
    const props: Array<string> = [];
    for (const attribute of opening ? childList(opening, "attributes") : []) {
      if (attribute.type === "JSXSpreadAttribute") {
        props.push(`...${emit(child(attribute, "argument")!)}`);
        continue;
      }
      const key = JSON.stringify(jsxName(child(attribute, "name")));
      const value = child(attribute, "value");
      if (!value) props.push(`${key}: true`);
      else if (value.type === "StringLiteral") props.push(`${key}: ${JSON.stringify(value.value)}`);
      else if (value.type === "JSXExpressionContainer")
        props.push(`${key}: ${emit(child(value, "expression")!)}`);
      else props.push(`${key}: ${emit(value)}`);
    }
    const children: Array<string> = [];
    for (const entry of childList(node, "children")) {
      if (entry.type === "JSXText") {
        const text = cleanJsxText(String(entry.value));
        if (text !== null) children.push(JSON.stringify(text));
      } else if (entry.type === "JSXExpressionContainer") {
        const expression = child(entry, "expression");
        if (expression && expression.type !== "JSXEmptyExpression") children.push(emit(expression));
      } else if (entry.type === "JSXSpreadChild") {
        children.push(`...${emit(child(entry, "expression")!)}`);
      } else if (isNode(entry)) {
        children.push(emit(entry));
      }
    }
    return `${WIDGET_H}(${[tag, `{${props.join(", ")}}`, ...children].join(", ")})`;
  };

  let out = "";
  let at = 0;
  for (const statement of childList(parsed.program, "body")) {
    if (statement.type === "ExportDefaultDeclaration") {
      const declaration = child(statement, "declaration");
      if (!declaration) continue;
      // `export default function () {}` has no name, so it becomes an expression.
      out += `${source.slice(at, statement.start)}${WIDGET_DRAWING} = (${emit(declaration)});`;
      at = statement.end;
    } else if (needsRewrite(statement)) {
      out += source.slice(at, statement.start) + emit(statement);
      at = statement.end;
    }
  }
  return { ok: true, code: STEP_PRELUDE + out + source.slice(at) };
}
