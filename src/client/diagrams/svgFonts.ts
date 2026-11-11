// Draw.io embeds a theme's Google font into an exported SVG as data URIs: every
// unicode-range subset Google serves (Cyrillic, Greek, Vietnamese, Latin...),
// and often each twice. That is about 590 KB per picture with Inter. A picture
// needs only the subsets that cover the characters it shows, once each.

const FONT_FACE = /@font-face\s*\{[^}]*\}/g;
const STYLE_BLOCK = /<style[^>]*>[\s\S]*?<\/style>/g;
const NUMERIC_ENTITY = /&(?:amp;)?#(x[0-9a-fA-F]+|[0-9]+);/g;

type Range = readonly [number, number];

/** The ranges of a `unicode-range` value, or null when the face names none (it covers all). */
export function unicodeRanges(face: string): ReadonlyArray<Range> | null {
  const value = /unicode-range\s*:\s*([^;}]*)/i.exec(face)?.[1];
  if (value === undefined) return null;
  const ranges: Array<Range> = [];
  for (const part of value.split(",")) {
    const match = /^\s*U\+([0-9A-Fa-f?]{1,6})(?:-([0-9A-Fa-f]{1,6}))?\s*$/i.exec(part);
    if (!match) continue;
    const [, start, end] = match;
    if (end !== undefined) ranges.push([parseInt(start!, 16), parseInt(end, 16)]);
    else ranges.push([parseInt(start!.replace(/\?/g, "0"), 16), parseInt(start!.replace(/\?/g, "F"), 16)]);
  }
  return ranges;
}

/** Every character the SVG can show: its text and attributes, entities decoded, styles left out. */
function charactersUsed(svg: string): ReadonlySet<number> {
  const text = svg
    .replace(STYLE_BLOCK, "")
    .replace(NUMERIC_ENTITY, (_, code: string) => {
      const point = code[0] === "x" ? parseInt(code.slice(1), 16) : parseInt(code, 10);
      // An entity past the last code point names no character.
      return point <= 0x10ffff ? String.fromCodePoint(point) : "";
    });
  const used = new Set<number>();
  for (const char of text) used.add(char.codePointAt(0)!);
  return used;
}

/**
 * Drops the embedded `@font-face` rules a picture does not need: a repeat of
 * one already kept, and a subset none of whose characters appear in it. A face
 * with no unicode-range is always kept. An SVG with no embedded fonts comes
 * back as it was.
 */
export function trimSvgFonts(svg: string): string {
  if (!svg.includes("@font-face")) return svg;
  const used = charactersUsed(svg);
  const seen = new Set<string>();
  return svg.replace(STYLE_BLOCK, (block) =>
    block.replace(FONT_FACE, (face) => {
      if (seen.has(face)) return "";
      seen.add(face);
      const ranges = unicodeRanges(face);
      if (ranges === null) return face;
      for (const code of used) {
        if (ranges.some(([start, end]) => code >= start && code <= end)) return face;
      }
      return "";
    }),
  );
}
