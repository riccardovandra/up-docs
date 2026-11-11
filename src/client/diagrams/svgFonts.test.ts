import { describe, expect, it } from "vitest";

import { trimSvgFonts, unicodeRanges } from "./svgFonts.ts";

const face = (range: string | null, tag: string) =>
  `@font-face {&#xa;  font-family: 'Inter';&#xa;  src: url("data:font/woff2;base64,${tag}") format('woff2');` +
  `${range === null ? "" : `&#xa;  unicode-range: ${range};`}&#xa;}`;

const LATIN = "U+0000-00FF, U+2000-206F";
const CYRILLIC = "U+0301, U+0400-045F";
const GREEK = "U+0370-03FF";

const svg = (label: string, faces: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg"><defs><style type="text/css">/* subsets */&#xa;${faces}</style></defs>` +
  `<g><foreignObject><div>${label}</div></foreignObject><text>${label}</text></g></svg>`;

const faces = (out: string) => (out.match(/@font-face/g) ?? []).length;

describe("trimSvgFonts", () => {
  it("keeps only the subsets the picture's text needs, once each", () => {
    const all = face(CYRILLIC, "CYR") + face(GREEK, "GRK") + face(LATIN, "LAT");
    const out = trimSvgFonts(svg("Hello", all + all));
    expect(faces(out)).toBe(1);
    expect(out).toContain("LAT");
    expect(out).not.toContain("CYR");
    expect(out).toContain("<div>Hello</div>");
  });

  it("keeps a subset for characters written as entities or as text", () => {
    const all = face(CYRILLIC, "CYR") + face(GREEK, "GRK") + face(LATIN, "LAT");
    expect(trimSvgFonts(svg("Hi &#x416;", all))).toContain("CYR");
    expect(trimSvgFonts(svg("Hi &amp;#1046;", all))).toContain("CYR");
    expect(trimSvgFonts(svg("Hi &#99999999;", all))).toContain("LAT");
    const greek = trimSvgFonts(svg("Hi Ω", all));
    expect(greek).toContain("GRK");
    expect(greek).not.toContain("CYR");
  });

  it("keeps a face that names no range, and leaves an SVG without fonts alone", () => {
    expect(trimSvgFonts(svg("Hi", face(null, "ALL")))).toContain("ALL");
    const plain = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    expect(trimSvgFonts(plain)).toBe(plain);
  });

  it("reads single code points, ranges and wildcards", () => {
    expect(unicodeRanges("unicode-range: U+0301, U+0400-045F, U+1F??;")).toEqual([
      [0x301, 0x301],
      [0x400, 0x45f],
      [0x1f00, 0x1fff],
    ]);
    expect(unicodeRanges("src: url(x)")).toBeNull();
  });
});
