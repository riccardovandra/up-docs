import { describe, expect, it } from "vitest";

import {
  checkVideosIn,
  isVideoLanguage,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_PARTS,
  parseVideoBlock,
  VIDEO_PART_BYTES,
  videoBlockBody,
  videoFileTitle,
  videoFileType,
  videosToLinks,
  videoTypeOf,
} from "./video.ts";

const YT = "dQw4w9WgXcQ";
const LOOM = "0123456789abcdef0123456789abcdef";
const FILE = "00000000-0000-4000-8000-000000000000.mp4";

describe("parseVideoBlock", () => {
  it.each([
    [`https://www.youtube.com/watch?v=${YT}`],
    [`https://youtube.com/watch?list=abc&v=${YT}&t=10`],
    [`http://m.youtube.com/watch?v=${YT}`],
    [`https://youtu.be/${YT}`],
    [`https://youtu.be/${YT}?si=abc`],
    [`https://www.youtube.com/shorts/${YT}`],
    [`https://www.youtube.com/embed/${YT}/`],
    [`https://www.youtube-nocookie.com/embed/${YT}`],
  ])("reads the YouTube link %s", (source) => {
    expect(parseVideoBlock(source)).toEqual({
      kind: "youtube",
      id: YT,
      title: null,
      watchUrl: `https://www.youtube.com/watch?v=${YT}`,
      embedUrl: `https://www.youtube-nocookie.com/embed/${YT}?autoplay=1`,
    });
  });

  it.each([
    [`https://www.loom.com/share/${LOOM}`],
    [`https://loom.com/share/${LOOM}?sid=abc`],
    [`https://www.loom.com/embed/${LOOM}`],
    [`https://www.loom.com/share/Weekly-update-${LOOM}`],
  ])("reads the Loom link %s", (source) => {
    expect(parseVideoBlock(source)).toEqual({
      kind: "loom",
      id: LOOM,
      title: null,
      watchUrl: `https://www.loom.com/share/${LOOM}`,
      embedUrl: `https://www.loom.com/embed/${LOOM}?autoplay=1`,
    });
  });

  it("reads an uploaded file and the title line", () => {
    const src = `/api/videos/doc-1/${FILE}`;
    expect(parseVideoBlock(`${src}\n  Launch walkthrough \n`)).toEqual({
      kind: "file",
      src,
      title: "Launch walkthrough",
      watchUrl: src,
      embedUrl: null,
    });
  });

  it.each([
    ["an empty block", ""],
    ["a script URL", "javascript:alert(1)"],
    ["a script URL shaped like a link", `javascript://www.youtube.com/watch?v=${YT}`],
    ["a data URL", "data:text/html,<script>alert(1)</script>"],
    ["a lookalike suffix", `https://youtube.com.evil.test/watch?v=${YT}`],
    ["a lookalike prefix", `https://notyoutube.com/watch?v=${YT}`],
    ["a lookalike short host", `https://youtu.be.evil.test/${YT}`],
    ["a lookalike Loom host", `https://www.loom.com.evil.test/share/${LOOM}`],
    ["a credential trick", `https://www.youtube.com@evil.test/watch?v=${YT}`],
    ["credentials on the real host", `https://user@www.youtube.com/watch?v=${YT}`],
    ["a port", `https://www.youtube.com:8443/watch?v=${YT}`],
    ["a trailing dot", `https://www.youtube.com./watch?v=${YT}`],
    ["the host in the path", `https://evil.test/www.youtube.com/watch?v=${YT}`],
    ["a short id", "https://www.youtube.com/watch?v=abc"],
    ["an id with a quote", `https://www.youtube.com/watch?v=dQw4w9WgXc"`],
    ["an extra path", `https://www.youtube.com/embed/${YT}/../../evil`],
    ["a channel page", "https://www.youtube.com/@creator"],
    ["a short Loom id", "https://www.loom.com/share/abc123"],
    ["an upper case Loom id", `https://www.loom.com/share/${LOOM.toUpperCase()}`],
    ["another site's video", "https://example.com/video.mp4"],
    ["a file name we never issue", "/api/videos/doc-1/x.mp4"],
    ["an executable extension", "/api/videos/doc-1/00000000-0000-4000-8000-000000000000.html"],
    ["a path escape", `/api/videos/../${FILE}`],
    ["a protocol-relative URL", `//evil.test/api/videos/doc-1/${FILE}`],
    ["a query on a file", `/api/videos/doc-1/${FILE}?x=1`],
    ["lines after the title", `https://youtu.be/${YT}\nTitle\nMore`],
  ])("refuses %s", (_name, source) => {
    expect(parseVideoBlock(source)).toBeNull();
  });

  it("builds embed URLs from the id, never from the doc's text", () => {
    const video = parseVideoBlock(`https://www.youtube.com/watch?v=${YT}&x="><script>`);
    expect(video?.embedUrl).toBe(`https://www.youtube-nocookie.com/embed/${YT}?autoplay=1`);
  });
});

describe("video constants and names", () => {
  it("sizes parts for the Worker limit and the cap", () => {
    expect(VIDEO_PART_BYTES).toBeLessThan(100_000_000);
    expect(MAX_VIDEO_PARTS * VIDEO_PART_BYTES).toBeGreaterThanOrEqual(MAX_VIDEO_BYTES);
  });

  it("knows only the names it issues", () => {
    expect(videoFileType(FILE)).toBe("video/mp4");
    expect(videoFileType(FILE.replace("mp4", "mov"))).toBe("video/quicktime");
    expect(videoFileType(FILE.replace("mp4", "webm"))).toBe("video/webm");
    expect(videoFileType("../x.mp4")).toBeNull();
    expect(videoFileType(FILE.replace("mp4", "png"))).toBeNull();
  });

  it("types a file by its reported type, then by extension when blank", () => {
    expect(videoTypeOf({ name: "a.bin", type: "video/webm" })).toBe("video/webm");
    expect(videoTypeOf({ name: "Screen Recording.MOV", type: "" })).toBe("video/quicktime");
    expect(videoTypeOf({ name: "a.mp4", type: "text/html" })).toBeNull();
    expect(videoTypeOf({ name: "a.txt", type: "" })).toBeNull();
  });

  it("recognises the language with or without trailing info", () => {
    expect(isVideoLanguage("t3-video")).toBe(true);
    expect(isVideoLanguage("t3-video extra")).toBe(true);
    expect(isVideoLanguage("t3-video-2")).toBe(false);
    expect(isVideoLanguage(null)).toBe(false);
  });

  it("writes a body with a one-line title", () => {
    expect(videoBlockBody("/a", null)).toBe("/a");
    expect(videoBlockBody("/a", " two\nlines ")).toBe("/a\ntwo lines");
    expect(videoFileTitle("Demo take.2.mov")).toBe("Demo take.2");
    expect(videoFileTitle(".mov")).toBeNull();
  });
});

describe("checkVideosIn", () => {
  const block = (body: string) => "```t3-video\n" + body + "\n```";

  it("passes valid blocks and text without any", () => {
    expect(checkVideosIn("No video here, https://youtu.be/x")).toBeNull();
    expect(checkVideosIn(block(`https://youtu.be/${YT}\nTitle`))).toBeNull();
  });

  it("names the broken block", () => {
    expect(checkVideosIn(block("https://example.com"))).toContain("The t3-video block");
    expect(checkVideosIn(`${block(`https://youtu.be/${YT}`)}\n\n${block("nope")}`)).toContain(
      "t3-video block 2",
    );
  });

  it("does not re-check a block left unchanged", () => {
    const old = block("https://example.com/old");
    expect(checkVideosIn(`${old}\n\nNew text`, old)).toBeNull();
    expect(checkVideosIn(block("https://example.com/new"), old)).not.toBeNull();
  });
});

describe("videosToLinks", () => {
  it("turns blocks into links, escaping the title", () => {
    const markdown = [
      "Before",
      "```t3-video\nhttps://youtu.be/" + YT + "\nThe [best](x) take\n```",
      "```t3-video\n/api/videos/d1/" + FILE + "\n```",
      "After",
    ].join("\n\n");
    expect(videosToLinks(markdown, "https://docs.test")).toBe(
      [
        "Before",
        `[The \\[best\\](x) take](https://www.youtube.com/watch?v=${YT})`,
        `[Video](https://docs.test/api/videos/d1/${FILE})`,
        "After",
      ].join("\n\n"),
    );
  });

  it("leaves invalid blocks and other fences alone", () => {
    const markdown = "```t3-video\nnope\n```\n\n```js\nconst a = 1;\n```\n";
    expect(videosToLinks(markdown, "https://docs.test")).toBe(markdown);
  });
});
