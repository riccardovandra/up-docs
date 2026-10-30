// A loose view of Babel's AST. Only @babel/parser is a dependency, so nodes
// are read through these helpers instead of @babel/types.

import { parse } from "@babel/parser";

export interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly loc: { readonly start: { readonly line: number; readonly column: number } };
  readonly [key: string]: unknown;
}

export const isNode = (value: unknown): value is AstNode =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string" &&
  typeof (value as { start?: unknown }).start === "number";

export const child = (node: AstNode, key: string): AstNode | null => {
  const value = node[key];
  return isNode(value) ? value : null;
};

export const childList = (node: AstNode, key: string): ReadonlyArray<AstNode> => {
  const value = node[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
};

const SKIPPED_KEYS = new Set([
  "loc",
  "extra",
  "leadingComments",
  "trailingComments",
  "innerComments",
]);

/** Every direct child node, in source order. */
export function childNodes(node: AstNode): ReadonlyArray<AstNode> {
  const found: Array<AstNode> = [];
  for (const [key, value] of Object.entries(node)) {
    if (SKIPPED_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) found.push(item);
    } else if (isNode(value)) {
      found.push(value);
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

export type ParseOutcome =
  | { readonly ok: true; readonly program: AstNode }
  | {
      readonly ok: false;
      readonly message: string;
      readonly line: number;
      readonly column: number;
    };

export function parseModule(source: string): ParseOutcome {
  try {
    const file = parse(source, { sourceType: "module", plugins: ["jsx"] }) as unknown as AstNode;
    const program = child(file, "program");
    if (!program) return { ok: false, message: "Could not read the module.", line: 1, column: 1 };
    return { ok: true, program };
  } catch (cause) {
    const loc = (cause as { loc?: { line?: number; column?: number } }).loc;
    const message = cause instanceof Error ? cause.message.replace(/\s*\(\d+:\d+\)$/, "") : "";
    return {
      ok: false,
      message: message || "The module does not parse.",
      line: loc?.line ?? 1,
      column: (loc?.column ?? 0) + 1,
    };
  }
}

/** JSX tag name as written: `rect`, `Box`, `claude.Visualize`. */
export function jsxName(name: AstNode | null): string {
  if (!name) return "";
  if (name.type === "JSXIdentifier") return String(name.name);
  if (name.type === "JSXNamespacedName") {
    return `${jsxName(child(name, "namespace"))}:${jsxName(child(name, "name"))}`;
  }
  if (name.type === "JSXMemberExpression") {
    return `${jsxName(child(name, "object"))}.${jsxName(child(name, "property"))}`;
  }
  return "";
}

export const elementName = (element: AstNode): string =>
  jsxName(child(child(element, "openingElement") ?? element, "name"));

export const elementAttributes = (element: AstNode): ReadonlyArray<AstNode> =>
  childList(child(element, "openingElement") ?? element, "attributes");

export function findAttribute(element: AstNode, name: string): AstNode | null {
  for (const attribute of elementAttributes(element)) {
    if (attribute.type === "JSXAttribute" && jsxName(child(attribute, "name")) === name) {
      return attribute;
    }
  }
  return null;
}

/**
 * The string an attribute holds when it is written as a literal, either
 * `a='x'` or `a={'x'}`. Null for anything computed.
 */
export function literalAttribute(attribute: AstNode | null): string | null {
  const value = attribute ? child(attribute, "value") : null;
  if (!value) return null;
  if (value.type === "StringLiteral") return String(value.value);
  if (value.type === "JSXExpressionContainer") {
    const expression = child(value, "expression");
    if (expression?.type === "StringLiteral") return String(expression.value);
    if (
      expression?.type === "TemplateLiteral" &&
      childList(expression, "expressions").length === 0
    ) {
      const quasi = childList(expression, "quasis")[0];
      const cooked = (quasi?.value as { cooked?: unknown } | undefined)?.cooked;
      return typeof cooked === "string" ? cooked : null;
    }
  }
  return null;
}

/**
 * JSX text as React reads it: lines are trimmed, blank lines dropped, and the
 * rest joined with single spaces. Null when nothing is left.
 */
export function cleanJsxText(value: string): string | null {
  const lines = value.split(/\r\n|\n|\r/);
  let lastNonEmpty = 0;
  for (let index = 0; index < lines.length; index++) {
    if (/[^ \t]/.test(lines[index] ?? "")) lastNonEmpty = index;
  }
  let text = "";
  for (let index = 0; index < lines.length; index++) {
    let line = (lines[index] ?? "").replace(/\t/g, " ");
    if (index !== 0) line = line.replace(/^ +/, "");
    if (index !== lines.length - 1) line = line.replace(/ +$/, "");
    if (!line) continue;
    if (index !== lastNonEmpty) line += " ";
    text += line;
  }
  return text ? text : null;
}
