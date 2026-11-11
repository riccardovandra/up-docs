import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Every stylesheet under src/client. */
function stylesheets(dir: string): Array<string> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return stylesheets(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

/** How deep the braces go at the end, and where they first close one too many. */
function braceDepth(css: string): { readonly end: number; readonly firstNegative: number | null } {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  let depth = 0;
  let firstNegative: number | null = null;
  for (const [index, char] of [...text].entries()) {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth < 0 && firstNegative === null) firstNegative = index;
  }
  return { end: depth, firstNegative };
}

describe("client stylesheets", () => {
  // An unclosed block swallows every rule after it: the diagram page tabs once
  // applied only inside a phone-width media query.
  it.each(stylesheets(join(import.meta.dirname, ".")))("%s closes every block it opens", (path) => {
    expect(braceDepth(readFileSync(path, "utf8"))).toEqual({ end: 0, firstNegative: null });
  });
});
