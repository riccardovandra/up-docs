import { EMBED_ORIGINS_META, frameAncestorsPolicy, PUBLIC_ORIGIN_META } from "../shared/embed.ts";

const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * Only T3 Code origins may frame the app. The HTML also carries the same list
 * so the embed bridge can check postMessage origins against it, and the
 * public origin so shared links point there.
 */
export async function withEmbedPolicy(
  response: Response,
  sources: ReadonlyArray<string>,
  publicOrigin: string,
): Promise<Response> {
  const headers = new Headers(response.headers);
  // Images load only from this origin: doc uploads under /api/images. A remote
  // URL in a doc's markdown is never fetched, so it cannot track readers.
  headers.set("Content-Security-Policy", `${frameAncestorsPolicy(sources)}; img-src 'self'`);
  const isHtml = (headers.get("Content-Type") ?? "").startsWith("text/html");
  if (!isHtml || !response.body) {
    return new Response(response.body, { status: response.status, headers });
  }
  const meta =
    `<meta name="${EMBED_ORIGINS_META}" content="${escapeAttribute(sources.join(" "))}">` +
    `<meta name="${PUBLIC_ORIGIN_META}" content="${escapeAttribute(publicOrigin)}">`;
  const html = (await response.text()).replace("</head>", `${meta}</head>`);
  headers.delete("Content-Length");
  headers.delete("ETag");
  return new Response(html, { status: response.status, headers });
}
