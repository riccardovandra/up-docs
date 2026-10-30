// Copied from t3code packages/shared/src/docPaths.ts at 2ebefb19b7d0be19dc77bdfe5a8b1b8c8714e280.
export const DOCS_ROOT = "docs";

export function docTitleFromPath(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  return name.replace(/[-_]+/g, " ").trim() || name;
}

export function slugifyDocTitle(title: string): string {
  return (
    title
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .replace(/-+$/, "") || "untitled"
  );
}

/**
 * Picks `<folder>/<slug>.md`, suffixing a number so an existing doc is never
 * overwritten. `existingPaths` holds lowercase paths, so names differing only
 * in case clash, as they do on case-insensitive disks.
 */
export function nextDocPath(
  folder: string,
  title: string,
  existingPaths: ReadonlySet<string>,
): string {
  const slug = slugifyDocTitle(title);
  for (let attempt = 1; ; attempt += 1) {
    const candidate = `${folder}/${attempt === 1 ? slug : `${slug}-${attempt}`}.md`;
    if (!existingPaths.has(candidate.toLowerCase())) return candidate;
  }
}

export function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path);
}

/** Folders whose markdown is tooling, vendored code or private state, never project docs. */
const SKIPPED_DOC_FOLDERS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".repos",
  ".t3",
  ".plans",
]);

/**
 * A repo-relative markdown path the Docs views may list, read and write: plain
 * `/`-separated segments, none of them in a skipped folder.
 */
export function isProjectDocPath(path: string): boolean {
  // The server trims paths before resolving them.
  if (!isMarkdownPath(path) || path !== path.trim()) return false;
  return path.split("/").every(
    (segment) =>
      segment !== "" &&
      segment !== "." &&
      segment !== ".." &&
      // Case-insensitive disks, and Windows dropping trailing dots and spaces.
      !SKIPPED_DOC_FOLDERS.has(segment.toLowerCase().replace(/[. ]+$/, "")) &&
      !/[\\\u0000-\u001f\u007f]/.test(segment),
  );
}

/**
 * The editors' markdown converters drop structure they have no node for.
 * Saving such a doc from a rich editor would silently rewrite it, so these
 * docs open read-only.
 */
export function unsupportedMarkdownReason(markdown: string): string | null {
  if (/^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(markdown)) return "front matter";
  if (/^\s{0,3}<(?!!--)[a-zA-Z][^>]*>/m.test(markdown)) return "HTML blocks";
  if (/^\s{0,3}\[\^[^\]]+\]:/m.test(markdown)) return "footnotes";
  return null;
}

export const DOC_EXCERPT_MAX_LENGTH = 280;

/**
 * A short plain-text preview for a doc card in the conversation. The leading
 * title heading is dropped because the card shows the title already.
 */
export function docExcerpt(markdown: string, maxLength = DOC_EXCERPT_MAX_LENGTH): string {
  const text = markdown
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .replace(/^\s*#\s+[^\n]*\n/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, "")
    .replace(/[*_`~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}
