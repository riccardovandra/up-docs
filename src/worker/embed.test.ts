import { describe, expect, it } from "vitest";

import { isAllowedEmbedOrigin, parseEmbedOrigins } from "../shared/embed.ts";
import { withEmbedPolicy } from "./embed.ts";

const SOURCES = parseEmbedOrigins(
  "https://app.t3.codes http://localhost:* http://127.0.0.1:* https://*.ts.net t3code://app, javascript:alert(1) * 'self'",
);

describe("embed policy", () => {
  it("keeps only host-sources from the var", () => {
    expect(SOURCES).toEqual([
      "https://app.t3.codes",
      "http://localhost:*",
      "http://127.0.0.1:*",
      "https://*.ts.net",
      "t3code://app",
    ]);
  });

  it("matches origins like the browser matches frame-ancestors", () => {
    expect(isAllowedEmbedOrigin("https://app.t3.codes", SOURCES)).toBe(true);
    expect(isAllowedEmbedOrigin("https://app.t3.codes:443", SOURCES)).toBe(true);
    expect(isAllowedEmbedOrigin("t3code://app", SOURCES)).toBe(true);
    expect(isAllowedEmbedOrigin("t3code-dev://app", SOURCES)).toBe(false);
    expect(isAllowedEmbedOrigin("https://app.t3.codes:8443", SOURCES)).toBe(false);
    expect(isAllowedEmbedOrigin("http://app.t3.codes", SOURCES)).toBe(false);
    expect(isAllowedEmbedOrigin("http://localhost:5733", SOURCES)).toBe(true);
    expect(isAllowedEmbedOrigin("https://box.tail1234.ts.net", SOURCES)).toBe(true);
    expect(isAllowedEmbedOrigin("https://ts.net", SOURCES)).toBe(false);
    expect(isAllowedEmbedOrigin("https://evil-ts.net", SOURCES)).toBe(false);
    expect(isAllowedEmbedOrigin("https://app.t3.codes.evil.com", SOURCES)).toBe(false);
    expect(isAllowedEmbedOrigin("null", SOURCES)).toBe(false);
  });

  it("sets frame-ancestors and hands the list to the page", async () => {
    const html = new Response("<html><head><title>Docs</title></head><body></body></html>", {
      headers: { "Content-Type": "text/html; charset=utf-8", ETag: '"x"' },
    });
    const response = await withEmbedPolicy(html, SOURCES, "https://docs.example");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors https://app.t3.codes http://localhost:* http://127.0.0.1:* https://*.ts.net t3code://app; img-src 'self'",
    );
    expect(response.headers.get("ETag")).toBeNull();
    expect(await response.text()).toContain(
      '<meta name="t3-embed-origins" content="https://app.t3.codes http://localhost:* http://127.0.0.1:* https://*.ts.net t3code://app"><meta name="t3-docs-public-origin" content="https://docs.example"></head>',
    );
  });

  it("refuses all framing when the var is empty", async () => {
    const response = await withEmbedPolicy(
      new Response("x", { headers: { "Content-Type": "text/javascript" } }),
      parseEmbedOrigins(undefined),
      "https://docs.example",
    );
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors 'none'; img-src 'self'",
    );
    expect(await response.text()).toBe("x");
  });
});
