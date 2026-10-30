import { describe, expect, it } from "vitest";

import { withAssetCaching } from "./assets.ts";

const REVALIDATE = "public, max-age=0, must-revalidate";

const asset = (contentType: string, status = 200) =>
  new Response(status === 304 ? null : "x", {
    status,
    headers: { "Content-Type": contentType, "Cache-Control": REVALIDATE },
  });

describe("asset caching", () => {
  it("lets browsers keep hashed build files", () => {
    for (const response of [
      withAssetCaching(asset("text/javascript"), "/assets/index-CdTZjA_R.js"),
      withAssetCaching(asset("text/css", 304), "/assets/index-Dza1uXgs.css"),
    ]) {
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    }
  });

  it("keeps the page and the fallback for a missing asset revalidated", () => {
    expect(withAssetCaching(asset("text/html"), "/").headers.get("Cache-Control")).toBe(REVALIDATE);
    expect(withAssetCaching(asset("text/html"), "/d/doc-1").headers.get("Cache-Control")).toBe(
      REVALIDATE,
    );
    expect(
      withAssetCaching(asset("text/html"), "/assets/index-old.js").headers.get("Cache-Control"),
    ).toBe(REVALIDATE);
    expect(
      withAssetCaching(asset("text/javascript", 404), "/assets/x.js").headers.get("Cache-Control"),
    ).toBe(REVALIDATE);
  });
});
