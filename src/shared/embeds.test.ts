import { describe, expect, it } from "vitest";

import {
  checkEmbedsIn,
  embedBlockBody,
  embedInfoString,
  embedOptions,
  embedsToLinks,
  isEmbedLanguage,
  matchEmbed,
  parseEmbedBlock,
} from "./embeds.ts";

const ACTIVITY = "7209442266791186432";
const LINKEDIN = {
  provider: "linkedin",
  kind: "post",
  id: ACTIVITY,
  canonicalUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${ACTIVITY}`,
  frameUrl: `https://www.linkedin.com/embed/feed/update/urn:li:activity:${ACTIVITY}?collapsed=1`,
};

describe("matchEmbed", () => {
  it.each([
    [`https://www.linkedin.com/posts/pierre_slug-here-activity-${ACTIVITY}-uyzh`],
    [`https://www.linkedin.com/posts/pierre_slug-activity-${ACTIVITY}-uyzh?utm_source=share&rcm=x`],
    [`https://fr.linkedin.com/posts/pierre_slug-activity-${ACTIVITY}-uyzh/`],
    [`https://linkedin.com/feed/update/urn:li:activity:${ACTIVITY}/`],
    [`https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A${ACTIVITY}`],
    [`https://www.linkedin.com/embed/feed/update/urn:li:activity:${ACTIVITY}`],
  ])("reads the LinkedIn link %s", (url) => {
    expect(matchEmbed(url)).toEqual(LINKEDIN);
  });

  it("keeps the urn type LinkedIn used", () => {
    expect(
      matchEmbed(`https://www.linkedin.com/posts/a_b-ugcPost-${ACTIVITY}-xY_z`)?.frameUrl,
    ).toBe(`https://www.linkedin.com/embed/feed/update/urn:li:ugcPost:${ACTIVITY}?collapsed=1`);
    expect(
      matchEmbed(`https://www.linkedin.com/feed/update/urn:li:share:${ACTIVITY}`)?.canonicalUrl,
    ).toBe(`https://www.linkedin.com/feed/update/urn:li:share:${ACTIVITY}`);
  });

  it.each([
    ["https://x.com/jack/status/20", "https://x.com/jack/status/20"],
    ["https://twitter.com/jack/status/20?s=20", "https://x.com/jack/status/20"],
    ["https://mobile.x.com/jack/status/20/photo/1", "https://x.com/jack/status/20"],
    ["https://x.com/i/web/status/20", "https://x.com/i/web/status/20"],
    ["https://x.com/i/status/20", "https://x.com/i/web/status/20"],
  ])("reads the X post %s", (url, canonicalUrl) => {
    expect(matchEmbed(url)).toEqual({
      provider: "x",
      kind: "post",
      id: "20",
      canonicalUrl,
      frameUrl: "https://platform.twitter.com/embed/Tweet.html?id=20&dnt=true",
    });
  });

  it.each([["https://x.com/i/article/1234"], ["https://x.com/someone/article/1234"]])(
    "reads the X article %s",
    (url) => {
      expect(matchEmbed(url)).toEqual({
        provider: "x",
        kind: "article",
        id: "1234",
        canonicalUrl: "https://x.com/i/article/1234",
        frameUrl: null,
      });
    },
  );

  it.each([
    [`https://linkedin.com.evil.test/posts/a-activity-${ACTIVITY}-x`],
    [`https://evillinkedin.com/posts/a-activity-${ACTIVITY}-x`],
    [`https://www.linkedin.com.evil.test/feed/update/urn:li:activity:${ACTIVITY}`],
    [`http://www.linkedin.com/feed/update/urn:li:activity:${ACTIVITY}`],
    [`https://user:pass@www.linkedin.com/feed/update/urn:li:activity:${ACTIVITY}`],
    [`https://www.linkedin.com:8443/feed/update/urn:li:activity:${ACTIVITY}`],
    [`https://www.linkedin.com/feed/update/urn:li:activity:123`],
    [`https://www.linkedin.com/in/pierre`],
    [`https://www.linkedin.com/pulse/some-article`],
    ["https://x.com.evil.test/jack/status/20"],
    ["https://x.com/jack/status/20abc"],
    ["https://x.com/this_handle_is_too_long/status/20"],
    ["https://x.com/jack"],
    ["javascript:alert(1)//x.com/jack/status/20"],
    ["data:text/html,https://x.com/jack/status/20"],
    ["not a url"],
  ])("does not treat %s as a provider post", (url) => {
    expect(matchEmbed(url)).toBeNull();
  });
});

describe("parseEmbedBlock", () => {
  it("reads a link and a caption", () => {
    expect(parseEmbedBlock(`https://x.com/jack/status/20\n  The first post  \n`)).toMatchObject({
      url: "https://x.com/jack/status/20",
      caption: "The first post",
      target: { provider: "x", id: "20" },
    });
  });

  it("takes any https link, with no provider", () => {
    expect(parseEmbedBlock("https://example.com/article")).toEqual({
      url: "https://example.com/article",
      caption: null,
      target: null,
    });
  });

  it.each([
    [""],
    ["http://example.com"],
    ["javascript:alert(1)"],
    ["/api/images/d/x.png"],
    ["https://example.com\ncaption\nthird line"],
    [`https://example.com\n${"c".repeat(301)}`],
    [`https://example.com/${"a".repeat(2048)}`],
  ])("refuses %j", (body) => {
    expect(parseEmbedBlock(body)).toBeNull();
  });

  it("builds a body from a link and a caption on one line", () => {
    expect(embedBlockBody("https://x.com/a/status/1", " Two\nlines ")).toBe(
      "https://x.com/a/status/1\nTwo lines",
    );
    expect(embedBlockBody("https://x.com/a/status/1")).toBe("https://x.com/a/status/1");
  });

  it("reads the compact option and ignores unknown words", () => {
    expect(embedOptions("t3-embed")).toEqual({ compact: false });
    expect(embedOptions("t3-embed compact")).toEqual({ compact: true });
    expect(embedOptions("t3-embed later-option compact")).toEqual({ compact: true });
    expect(embedInfoString(true)).toBe("t3-embed compact");
    expect(embedInfoString(false)).toBe("t3-embed");
  });

  it("matches the language's first word", () => {
    expect(isEmbedLanguage("t3-embed")).toBe(true);
    expect(isEmbedLanguage(" t3-embed extra")).toBe(true);
    expect(isEmbedLanguage("t3-embeds")).toBe(false);
    expect(isEmbedLanguage(null)).toBe(false);
  });
});

describe("checkEmbedsIn", () => {
  it("passes valid blocks and names the bad one", () => {
    expect(checkEmbedsIn("```t3-embed\nhttps://x.com/a/status/1\nCaption\n```")).toBeNull();
    const problem = checkEmbedsIn(
      "```t3-embed\nhttps://x.com/a/status/1\n```\n\n```t3-embed\nhttp://x.com/a/status/1\n```",
    );
    expect(problem).toContain("t3-embed block 2");
  });

  it("does not re-check a block left as it was", () => {
    const old = "```t3-embed\nnot a link\n```";
    expect(checkEmbedsIn(`${old}\n\nNew line.`, old)).toBeNull();
    expect(checkEmbedsIn(old)).toContain("The t3-embed block");
  });
});

describe("embedsToLinks", () => {
  it("turns blocks into links to the post", () => {
    const markdown = [
      "Intro",
      "",
      `\`\`\`t3-embed\nhttps://www.linkedin.com/posts/a_b-activity-${ACTIVITY}-x?utm=1\nThe hook [1]\n\`\`\``,
      "",
      "```t3-embed\nhttps://x.com/jack/status/20\n```",
      "",
      "```t3-embed\nhttps://example.com/page\n```",
    ].join("\n");
    expect(embedsToLinks(markdown)).toBe(
      [
        "Intro",
        "",
        `[The hook \\[1\\]](https://www.linkedin.com/feed/update/urn:li:activity:${ACTIVITY})`,
        "",
        "[X post](https://x.com/jack/status/20)",
        "",
        "[https://example.com/page](https://example.com/page)",
      ].join("\n"),
    );
  });
});
