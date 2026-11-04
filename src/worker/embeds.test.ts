import { describe, expect, it } from "vitest";

import type { DocRole } from "../shared/access.ts";
import type { EmbedSnapshot } from "../shared/embeds.ts";
import type { DocWithTabs } from "../shared/protocol.ts";
import {
  decodeEntities,
  jsonLd,
  linkedinPost,
  MAX_EMBEDS_PER_DOC,
  metaTags,
  openGraphPost,
  xPost,
  xToken,
} from "./embeds.ts";
import { makeApiHarness } from "./testing/apiHarness.ts";

const ACTIVITY = "7209442266791186432";
const POST_URL = `https://www.linkedin.com/posts/pierre_hooks-activity-${ACTIVITY}-uyzh`;
const PAGE_URL = `https://www.linkedin.com/feed/update/urn:li:activity:${ACTIVITY}`;
const IMAGE_URL = "https://media.licdn.com/dms/image/v2/abc/feedshare-shrink_800/0/1?e=1&t=x";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2]);

const linkedinPage = (posting: Record<string, unknown> = {}) => `<!doctype html><html><head>
<meta property="og:title" content="Fallback title &amp; more">
<meta property="og:image" content="${IMAGE_URL.replace(/&/g, "&amp;")}">
<script type="application/ld+json">${JSON.stringify({
  "@context": "http://schema.org",
  "@type": "SocialMediaPosting",
  headline: "Hooks that work.",
  articleBody: "Hooks that work.\n\n1. Start with a number.\n<script>alert(1)</script>",
  datePublished: "2024-06-20T06:29:41.332Z",
  commentCount: 412,
  image: { "@type": "ImageObject", url: IMAGE_URL },
  author: { "@type": "Person", name: "Pierre Herubel", url: "https://www.linkedin.com/in/p" },
  interactionStatistic: [
    {
      "@type": "InteractionCounter",
      interactionType: "http://schema.org/LikeAction",
      userInteractionCount: 1611,
    },
  ],
  ...posting,
}).replace(/</g, "\\u003c")}</script></head><body></body></html>`;

describe("page readers", () => {
  it("decodes entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#x27; &bogus; &#0;")).toBe(
      "a & b <c> \"d\" 'e' &bogus; &#0;",
    );
  });

  it("reads meta tags in either attribute order, first value winning", () => {
    const tags = metaTags(
      `<meta content="One" property="og:title"><meta property='og:title' content='Two'><meta name="description" content="D">`,
    );
    expect(tags.get("og:title")).toBe("One");
    expect(tags.get("description")).toBe("D");
  });

  it("skips broken JSON-LD and flattens @graph", () => {
    const html = `<script type="application/ld+json">{oops</script><script type="application/ld+json">{"@graph":[{"@type":"A"}]}</script>`;
    expect(jsonLd(html).map((item) => item["@type"])).toEqual([undefined, "A"]);
  });

  it("reads a LinkedIn post as plain strings", () => {
    expect(linkedinPost(linkedinPage())).toEqual({
      author: "Pierre Herubel",
      handle: null,
      title: "Hooks that work.",
      text: "Hooks that work.\n\n1. Start with a number.\n<script>alert(1)</script>",
      publishedAt: "2024-06-20T06:29:41.332Z",
      imageSource: IMAGE_URL,
      likes: 1611,
      comments: 412,
    });
  });

  it("refuses a LinkedIn page with no post in it, such as a sign-in wall", () => {
    expect(linkedinPost(`<meta property="og:title" content="LinkedIn">`)).toBeNull();
  });

  it("caps long text", () => {
    const text = linkedinPost(linkedinPage({ articleBody: "x".repeat(20_000) }))?.text ?? "";
    expect(Array.from(text)).toHaveLength(10_000);
    expect(text.endsWith("…")).toBe(true);
  });

  it("reads an X post, trimming media links and expanding t.co links", () => {
    expect(
      xPost({
        __typename: "Tweet",
        text: "Read this https://t.co/abc &amp; more https://t.co/media",
        display_text_range: [0, 38],
        entities: {
          urls: [{ url: "https://t.co/abc", expanded_url: "https://example.com/a" }],
          media: [{ url: "https://t.co/media" }],
        },
        created_at: "2006-03-21T20:50:14.000Z",
        favorite_count: 10,
        conversation_count: 2,
        user: { name: "jack", screen_name: "jack" },
        mediaDetails: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/a.jpg" }],
      }),
    ).toEqual({
      author: "jack",
      handle: "jack",
      title: null,
      text: "Read this https://example.com/a & more",
      publishedAt: "2006-03-21T20:50:14.000Z",
      imageSource: "https://pbs.twimg.com/media/a.jpg",
      likes: 10,
      comments: 2,
    });
  });

  it("prefers an X long post's full text", () => {
    const post = xPost({
      __typename: "Tweet",
      text: "Short…",
      note_tweet: { note_tweet_results: { result: { text: "The whole long post" } } },
    });
    expect(post?.text).toBe("The whole long post");
  });

  it("refuses a removed X post", () => {
    expect(xPost({ __typename: "TweetTombstone" })).toBeNull();
    expect(xPost("nope")).toBeNull();
  });

  it("reads Open Graph tags", () => {
    expect(
      openGraphPost(
        `<meta property="og:title" content="An article"><meta property="og:description" content="Body"><meta property="og:image" content="https://pbs.twimg.com/a.jpg">`,
      ),
    ).toMatchObject({
      title: "An article",
      text: "Body",
      imageSource: "https://pbs.twimg.com/a.jpg",
    });
    expect(openGraphPost("<html></html>")).toBeNull();
  });

  it("uses a shared link's preview image when a post has no media", () => {
    const post = xPost({
      __typename: "Tweet",
      text: "New article",
      card: {
        binding_values: {
          thumbnail_image_large: { image_value: { url: "https://pbs.twimg.com/card_img/1/a.jpg" } },
        },
      },
    });
    expect(post?.imageSource).toBe("https://pbs.twimg.com/card_img/1/a.jpg");
  });

  it("refuses X's generic page for a missing article", async () => {
    const { api, owner, embed } = await setup();
    api.remote.set(
      "https://x.com/i/article/1234",
      () =>
        new Response(
          `<meta property="og:title" content="X - The Everything App"/><meta property="og:image" content="https://abs.twimg.com/x-web/assets/og/default-og.a.jpg"/>`,
        ),
    );
    expect((await embed(owner, { url: "https://x.com/i/article/1234" })).status).toBe(502);
    expect(api.fetched[0]!.headers.get("User-Agent")).toBe("Twitterbot/1.0");
  });

  it("computes the token X's widget sends", () => {
    expect(xToken("1585841080431321088")).toBe("3ue2efeb2g");
  });
});

async function setup() {
  const api = makeApiHarness();
  const owner = await api.signIn();
  const created = (await (
    await api.call("POST", "/api/docs", { body: { title: "Study" }, headers: { Cookie: owner } })
  ).json()) as DocWithTabs;
  const docId = created.doc.id;
  const person = async (email: string, role: DocRole) => {
    await api.call("POST", `/api/docs/${docId}/members`, {
      body: { email, role },
      headers: { Cookie: owner },
    });
    return api.signIn(email);
  };
  const embed = (cookie: string, body: unknown) =>
    api.call("POST", `/api/docs/${docId}/embeds`, { body, headers: { Cookie: cookie } });
  const page =
    (html = linkedinPage()) =>
    () =>
      new Response(html, { headers: { "Content-Type": "text/html" } });
  const image = () => new Response(PNG.slice(), { headers: { "Content-Type": "image/png" } });
  return { api, owner, docId, person, embed, page, image };
}

describe("POST /api/docs/:id/embeds", () => {
  it("takes a copy once, stores its image in the doc, and serves the copy to viewers", async () => {
    const { api, owner, docId, person, embed, page, image } = await setup();
    api.remote.set(PAGE_URL, page());
    api.remote.set(IMAGE_URL, image);

    const viewer = await person("v@example.com", "viewer");
    const first = await embed(viewer, { url: POST_URL });
    expect(first.status).toBe(200);
    const { embed: snapshot } = (await first.json()) as { embed: EmbedSnapshot };
    expect(snapshot).toMatchObject({
      provider: "linkedin",
      url: PAGE_URL,
      author: "Pierre Herubel",
      likes: 1611,
      fetchedAt: api.clock.now,
    });
    expect(snapshot.image).toMatch(new RegExp(`^/api/images/${docId}/[0-9a-f-]{36}\\.png$`));
    expect(api.fetched.map((request) => request.url)).toEqual([PAGE_URL, IMAGE_URL]);
    expect(api.fetched[0]!.headers.get("User-Agent")).toContain("UPDocs");

    // The image is a doc image: served to readers, never from LinkedIn.
    const served = await api.call("GET", snapshot.image!, { headers: { Cookie: viewer } });
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);

    // Any link form for the same post reads the same copy, with no new fetch.
    const again = await embed(owner, { url: PAGE_URL });
    expect(((await again.json()) as { embed: EmbedSnapshot }).embed).toEqual(snapshot);
    expect(api.fetched).toHaveLength(2);
  });

  it("lets only an editor retake a copy, and keeps the old one when that fails", async () => {
    const { api, owner, person, embed, page, image } = await setup();
    api.remote.set(PAGE_URL, page());
    api.remote.set(IMAGE_URL, image);
    const first = (
      (await (await embed(owner, { url: POST_URL })).json()) as { embed: EmbedSnapshot }
    ).embed;

    const viewer = await person("v@example.com", "viewer");
    expect((await embed(viewer, { url: POST_URL, refresh: true })).status).toBe(403);

    api.clock.now += 1000;
    api.remote.set(PAGE_URL, page(linkedinPage({ commentCount: 500 })));
    const retaken = await embed(owner, { url: POST_URL, refresh: true });
    expect(((await retaken.json()) as { embed: EmbedSnapshot }).embed).toMatchObject({
      comments: 500,
      fetchedAt: api.clock.now,
    });

    api.remote.delete(PAGE_URL);
    expect((await embed(owner, { url: POST_URL, refresh: true })).status).toBe(502);
    const kept = (
      (await (await embed(owner, { url: POST_URL })).json()) as { embed: EmbedSnapshot }
    ).embed;
    expect(kept.comments).toBe(500);
    expect(kept.fetchedAt).toBeGreaterThan(first.fetchedAt);
  });

  it("refuses links no provider knows, without fetching", async () => {
    const { api, owner, embed } = await setup();
    for (const url of ["https://example.com/post", "http://x.com/a/status/1", 42]) {
      const response = await embed(owner, { url });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "embed_unsupported" });
    }
    expect(api.fetched).toHaveLength(0);
  });

  it("refuses people who cannot read the doc", async () => {
    const { api, owner, embed } = await setup();
    // Someone signed in, on another doc only.
    const other = (await (
      await api.call("POST", "/api/docs", { body: { title: "Other" }, headers: { Cookie: owner } })
    ).json()) as DocWithTabs;
    await api.call("POST", `/api/docs/${other.doc.id}/members`, {
      body: { email: "s@example.com", role: "editor" },
      headers: { Cookie: owner },
    });
    const stranger = await api.signIn("s@example.com");
    expect((await embed(stranger, { url: POST_URL })).status).toBe(404);
    expect(api.fetched).toHaveLength(0);
  });

  it("reports a post it cannot read and keeps nothing", async () => {
    const { api, owner, docId, embed, page } = await setup();
    api.remote.set(PAGE_URL, page(`<meta property="og:title" content="Sign in">`));
    const response = await embed(owner, { url: POST_URL });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "embed_unavailable" });
    const rows = await api.db
      .prepare("SELECT count(*) AS n FROM embed_snapshots WHERE doc_id = ?")
      .bind(docId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("follows redirects on the provider's hosts only", async () => {
    const { api, owner, embed, page } = await setup();
    const regional = `https://fr.linkedin.com/feed/update/urn:li:activity:${ACTIVITY}`;
    api.remote.set(
      PAGE_URL,
      () => new Response(null, { status: 301, headers: { Location: regional } }),
    );
    api.remote.set(regional, page());
    expect((await embed(owner, { url: POST_URL })).status).toBe(200);

    const off = await setup();
    off.api.remote.set(
      PAGE_URL,
      () => new Response(null, { status: 302, headers: { Location: "https://evil.test/page" } }),
    );
    off.api.remote.set("https://evil.test/page", page());
    expect((await off.embed(off.owner, { url: POST_URL })).status).toBe(502);
    expect(off.api.fetched.map((request) => request.url)).toEqual([PAGE_URL]);
  });

  it("copies images only from the provider's image hosts, and only real images", async () => {
    const { api, owner, embed, page } = await setup();
    const elsewhere = "https://evil.test/a.png";
    api.remote.set(PAGE_URL, page(linkedinPage({ image: { url: elsewhere } })));
    api.remote.set(
      elsewhere,
      () => new Response(PNG.slice(), { headers: { "Content-Type": "image/png" } }),
    );
    const outside = (
      (await (await embed(owner, { url: POST_URL })).json()) as { embed: EmbedSnapshot }
    ).embed;
    expect(outside.image).toBeNull();
    expect(api.fetched.map((request) => request.url)).not.toContain(elsewhere);

    const html = await setup();
    html.api.remote.set(PAGE_URL, html.page());
    html.api.remote.set(
      IMAGE_URL,
      () =>
        new Response("<html><script>alert(1)</script>", {
          headers: { "Content-Type": "image/png" },
        }),
    );
    const disguised = (
      (await (await html.embed(html.owner, { url: POST_URL })).json()) as { embed: EmbedSnapshot }
    ).embed;
    expect(disguised.image).toBeNull();
    expect(disguised.text).toContain("Start with a number");
  });

  it("refuses a page over the size cap", async () => {
    const { api, owner, embed } = await setup();
    api.remote.set(PAGE_URL, () => new Response("x".repeat(2 * 1024 * 1024 + 1)));
    expect((await embed(owner, { url: POST_URL })).status).toBe(502);
  });

  it("reads X posts from X's embed feed", async () => {
    const { api, owner, embed } = await setup();
    const feed = `https://cdn.syndication.twimg.com/tweet-result?id=20&lang=en&token=${xToken("20")}`;
    api.remote.set(feed, () =>
      Response.json({
        __typename: "Tweet",
        text: "just setting up my twttr",
        user: { name: "jack", screen_name: "jack" },
      }),
    );
    const response = await embed(owner, { url: "https://twitter.com/jack/status/20" });
    expect(((await response.json()) as { embed: EmbedSnapshot }).embed).toMatchObject({
      provider: "x",
      kind: "post",
      url: "https://x.com/jack/status/20",
      text: "just setting up my twttr",
      handle: "jack",
      image: null,
    });
  });

  it("caps copies per doc", async () => {
    const { api, owner, docId, embed } = await setup();
    for (let index = 0; index < MAX_EMBEDS_PER_DOC; index += 1) {
      await api.db
        .prepare(
          "INSERT INTO embed_snapshots (doc_id, url, data, fetched_at) VALUES (?, ?, '{}', 0)",
        )
        .bind(docId, `https://x.com/a/status/${index}`)
        .run();
    }
    expect((await embed(owner, { url: POST_URL })).status).toBe(429);
  });

  it("removes copies with their doc", async () => {
    const { api, owner, docId, embed, page } = await setup();
    api.remote.set(PAGE_URL, page());
    await embed(owner, { url: POST_URL });
    await api.call("DELETE", `/api/docs/${docId}`, { headers: { Cookie: owner } });
    const rows = await api.db
      .prepare("SELECT count(*) AS n FROM embed_snapshots WHERE doc_id = ?")
      .bind(docId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });
});
