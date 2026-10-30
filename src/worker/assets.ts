/**
 * Vite names every file under /assets/ by its content hash, so browsers may
 * keep them forever instead of revalidating on each load. A missing asset
 * falls back to index.html, which must stay revalidated.
 */
export function withAssetCaching(response: Response, pathname: string): Response {
  const hashed =
    pathname.startsWith("/assets/") &&
    (response.status === 200 || response.status === 304) &&
    !(response.headers.get("Content-Type") ?? "").startsWith("text/html");
  if (!hashed) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(response.body, { status: response.status, headers });
}
