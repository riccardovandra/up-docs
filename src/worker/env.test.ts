import { describe, expect, it } from "vitest";

import { resolvePublicOrigin } from "./env.ts";

const REQUEST_URL = "https://up-docs.example.workers.dev/d/abc?x=1";

describe("resolvePublicOrigin", () => {
  it("uses PUBLIC_ORIGIN when set", () => {
    expect(resolvePublicOrigin("https://docs.example.com", REQUEST_URL)).toBe(
      "https://docs.example.com",
    );
  });

  it("drops a trailing slash or path", () => {
    expect(resolvePublicOrigin(" https://docs.example.com/app/ ", REQUEST_URL)).toBe(
      "https://docs.example.com",
    );
  });

  it("falls back to the request's origin when unset, blank or malformed", () => {
    for (const configured of [undefined, "", "   ", "docs.example.com"]) {
      expect(resolvePublicOrigin(configured, REQUEST_URL)).toBe(
        "https://up-docs.example.workers.dev",
      );
    }
  });
});
