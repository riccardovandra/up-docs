// The design editor's static files (the OpenPencil fork's build, unpacked
// into dist/designer/ by scripts/fetch-designer.ts). Owner: S2.
//
// The editor runs on an origin of its own (DESIGNER_ORIGIN), so it gets a
// real origin (storage, workers, HTTP cache work) but never the app's session:
// on that host the Worker serves the editor's files and nothing else (no API,
// no MCP, no app pages). The app frames it and the two talk only by
// postMessage, each checking the other's origin.
//
// Without DESIGNER_ORIGIN (a fresh Deploy to Cloudflare install), the editor
// is served under /designer/ on the app's own origin. That works, but is less
// isolated: the editor's code then shares the app's origin and session. So
// there the editor gets no 'unsafe-eval', and the agent tools that compile
// JSX at run time (render, replace_node, apply_patch) do not work; S3 hides them.

import { DESIGNER_BASE_PATH, isDesignAgentSocketPath } from "../shared/design.ts";

/**
 * The editor's own origin, or null to serve it under /designer/ on the app's
 * origin. It needs PUBLIC_ORIGIN too: the editor may only be framed by the
 * app, and on the editor's host the app's origin cannot be read from the request.
 */
export function designerOrigin(input: {
  readonly DESIGNER_ORIGIN?: string | undefined;
  readonly PUBLIC_ORIGIN?: string | undefined;
}): string | null {
  const designer = input.DESIGNER_ORIGIN?.trim();
  const app = input.PUBLIC_ORIGIN?.trim();
  if (!designer || !app || !URL.canParse(designer) || !URL.canParse(app)) return null;
  const origin = new URL(designer).origin;
  return origin === new URL(app).origin || origin === "null" ? null : origin;
}

/** Whether the request came to the editor's own host. */
export const isDesignerHost = (request: Request, origin: string | null) =>
  origin !== null && new URL(request.url).host === new URL(origin).host;

/**
 * A request to the app made by the editor's code: refused before any app
 * route runs, whatever its method or Upgrade. The editor and the app are
 * usually the same site (design.<domain> and docs.<domain>), so the browser
 * sends the app's session cookie, even SameSite=Strict, with the editor's
 * requests and socket handshakes; without this, code running in the editor
 * could act as the signed-in person. The one path it may reach is the design
 * agent socket (S3), which takes a one-use ticket and never the cookie; it is
 * 404 until S3 serves it. Null for any other request.
 */
export function refuseDesignerOriginRequest(
  request: Request,
  origin: string | null,
): Response | null {
  if (origin === null || request.headers.get("Origin") !== origin) return null;
  const { pathname } = new URL(request.url);
  // The one exception, left to the route that serves it (S3; 404 until then).
  if (isDesignAgentSocketPath(pathname)) return null;
  return new Response("Forbidden", {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Whether the path is the editor's on the app's origin. */
export const isDesignerPath = (pathname: string) =>
  pathname === DESIGNER_BASE_PATH.slice(0, -1) || pathname.startsWith(DESIGNER_BASE_PATH);

/**
 * The editor's CSP. CanvasKit, Taffy and HarfBuzz are WebAssembly, so
 * 'wasm-unsafe-eval'. On its own origin the editor also gets 'unsafe-eval':
 * the agent tools render, replace_node and apply_patch compile JSX with
 * `new Function`, and that origin holds no session. Never on the app's
 * origin (the /designer/ fallback). `appOrigin` (own-origin mode)
 * may frame it and take its agent socket; `frameAncestors` are T3 Code's
 * origins, which may frame the app around it.
 */
export function designerCsp(input: {
  readonly appOrigin: string | null;
  readonly frameAncestors: ReadonlyArray<string>;
}): string {
  const app = input.appOrigin;
  const socket = app ? ` ${app.replace(/^http/, "ws")}` : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${app ? " 'unsafe-eval'" : ""} blob:`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self' blob: data:",
    `connect-src 'self' blob: data:${socket}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    // Editor code may not post forms (to the app or anywhere) or move its base URL.
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${[app ?? "'self'", ...input.frameAncestors].join(" ")}`,
  ].join("; ");
}

const notFound = () =>
  new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });

/** The app's own index.html, which the assets binding serves for any missing path. */
async function isAppFallback(assets: Fetcher, origin: string, response: Response) {
  if (!(response.headers.get("Content-Type") ?? "").startsWith("text/html")) return false;
  const app = await assets.fetch(new Request(`${origin}/index.html`, { method: "HEAD" }));
  const etag = response.headers.get("ETag");
  const appEtag = app.headers.get("ETag");
  if (etag && appEtag) return etag === appEtag;
  // No ETags to compare: compare the bytes.
  const [mine, theirs] = await Promise.all([
    response.clone().text(),
    assets.fetch(new Request(`${origin}/index.html`)).then((page) => page.text()),
  ]);
  return mine === theirs;
}

/**
 * A top-level navigation: `Sec-Fetch-Dest: document`, or no Sec-Fetch-Dest at
 * all (an old browser, or curl) for an HTML file. The editor's own loads say
 * iframe, script, worker, font, image or empty.
 */
function isNavigation(request: Request, html: boolean): boolean {
  const dest = request.headers.get("Sec-Fetch-Dest");
  return dest === "document" || (dest === null && html);
}

/** The app's Designs library, where a visit to the editor's host belongs. */
const toApp = (appOrigin: string) =>
  new Response(null, {
    status: 302,
    headers: { Location: `${appOrigin}/designs`, "Cache-Control": "no-store" },
  });

/**
 * Serves one editor file. On the editor's host every path maps under
 * /designer/ (`/` is the editor), on the app's host only /designer/ paths
 * come here. A missing file is 404, never the app's page (the assets binding
 * answers a missing path with it) and never the editor's index.html: in host
 * mode the editor has no routes of its own, so the API's paths stay dead here.
 */
export async function designerResponse(
  request: Request,
  input: {
    readonly assets: Fetcher;
    /** Own-origin mode: the app's origin. Null when served on the app's origin. */
    readonly appOrigin: string | null;
    readonly frameAncestors: ReadonlyArray<string>;
  },
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const url = new URL(request.url);
  const base = DESIGNER_BASE_PATH.slice(0, -1);
  if (url.pathname === base) {
    // `/designer` is the editor's page: a tab on its own host goes to the app.
    if (input.appOrigin !== null && isNavigation(request, true)) return toApp(input.appOrigin);
    return Response.redirect(`${url.origin}${DESIGNER_BASE_PATH}${url.search}`, 302);
  }
  const path = url.pathname.startsWith(DESIGNER_BASE_PATH)
    ? url.pathname
    : `${base}${url.pathname}`;
  // Only the editor's files: no dot segments, no encoded slashes.
  if (/(^|\/)\.\.?(\/|$)|%2f|%5c/i.test(path)) return notFound();
  const fetchAsset = (assetPath: string) =>
    input.assets.fetch(
      new Request(`${url.origin}${assetPath}`, {
        method: request.method,
        headers: request.headers,
      }),
    );
  const response = await fetchAsset(path);
  if (response.status === 200 && (await isAppFallback(input.assets, url.origin, response))) {
    return notFound();
  }
  if (response.status === 404) return notFound();
  const html = (response.headers.get("Content-Type") ?? "").startsWith("text/html");
  // On its own host the editor is only ever framed by the app: a visit in a
  // tab of its own goes to the app's Designs library instead.
  if (input.appOrigin !== null && isNavigation(request, html)) {
    return toApp(input.appOrigin);
  }
  const headers = new Headers(response.headers);
  // The same URL is the editor in a frame and a redirect in a tab.
  if (input.appOrigin !== null) headers.append("Vary", "Sec-Fetch-Dest");
  headers.set(
    "Content-Security-Policy",
    designerCsp({ appOrigin: input.appOrigin, frameAncestors: input.frameAncestors }),
  );
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Referrer-Policy", "no-referrer");
  // Hashed build files never change; everything else revalidates.
  const hashed = path.startsWith(`${DESIGNER_BASE_PATH}assets/`) && response.status === 200;
  headers.set("Cache-Control", hashed ? "public, max-age=31536000, immutable" : "no-cache");
  return new Response(response.body, { status: response.status, headers });
}
