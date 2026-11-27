import { afterEach, describe, expect, it, vi } from "vitest";

import { designAgentSocketPath } from "../shared/design.ts";
import { designerOrigin } from "./designerHost.ts";
import { makeApiHarness } from "./testing/apiHarness.ts";
import type { Env } from "./env.ts";
import worker from "./index.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const APP_INDEX = "<!doctype html><html><head></head><body>app</body></html>";
const EDITOR_INDEX = "<!doctype html><html><head></head><body>editor</body></html>";

/**
 * The assets binding as wrangler configures it: files by path, a folder's
 * index.html for its path, and the app's index.html for anything missing
 * (single-page-application), with an ETag per file.
 */
function fakeAssets(): Fetcher {
  const files: Record<string, { body: string; type: string }> = {
    "/index.html": { body: APP_INDEX, type: "text/html; charset=utf-8" },
    "/assets/app.js": { body: "app()", type: "text/javascript" },
    "/designer/index.html": { body: EDITOR_INDEX, type: "text/html; charset=utf-8" },
    "/designer/assets/main-abc.js": { body: "editor()", type: "text/javascript" },
    "/designer/canvaskit.wasm": { body: "wasm", type: "application/wasm" },
  };
  const fetch = async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    const { pathname } = new URL(request.url);
    const path = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const file = files[path] ?? files["/index.html"]!;
    const name = files[path] ? path : "/index.html";
    return new Response(request.method === "HEAD" ? null : file.body, {
      headers: { "Content-Type": file.type, ETag: `"${name}"` },
    });
  };
  return { fetch } as unknown as Fetcher;
}

const env = (vars: Partial<Env> = {}): Env =>
  ({
    ASSETS: fakeAssets(),
    FRAME_ANCESTORS: "https://app.t3.codes",
    ...vars,
  }) as unknown as Env;

const OWN = { PUBLIC_ORIGIN: "https://docs.test", DESIGNER_ORIGIN: "https://design.docs.test" };
const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;
const get = (url: string, vars: Partial<Env>) =>
  worker.fetch(new Request(url) as never, env(vars), ctx);

describe("designerOrigin", () => {
  it("needs both origins, and a different one for the editor", () => {
    expect(designerOrigin(OWN)).toBe("https://design.docs.test");
    expect(
      designerOrigin({
        DESIGNER_ORIGIN: "https://design.docs.test/x/",
        PUBLIC_ORIGIN: "https://docs.test",
      }),
    ).toBe("https://design.docs.test");
    expect(designerOrigin({ DESIGNER_ORIGIN: "https://design.docs.test" })).toBeNull();
    expect(designerOrigin({ PUBLIC_ORIGIN: "https://docs.test" })).toBeNull();
    expect(
      designerOrigin({ DESIGNER_ORIGIN: "https://docs.test", PUBLIC_ORIGIN: "https://docs.test" }),
    ).toBeNull();
    expect(
      designerOrigin({ DESIGNER_ORIGIN: "not a url", PUBLIC_ORIGIN: "https://docs.test" }),
    ).toBeNull();
  });
});

describe("the editor's own host", () => {
  it("serves the editor with its CSP, framed only by the app (and T3 Code around it)", async () => {
    const response = await get("https://design.docs.test/designer/?host=up-docs", OWN);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(EDITOR_INDEX);
    const csp = response.headers.get("Content-Security-Policy")!;
    // Its own origin holds no session, so the JSX-compiling agent tools may eval there.
    expect(csp).toContain(
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' 'unsafe-eval' blob:",
    );
    expect(csp).toContain("frame-ancestors https://docs.test https://app.t3.codes");
    expect(csp).toContain("connect-src 'self' blob: data: wss://docs.test");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    // The root is the editor too.
    expect(await (await get("https://design.docs.test/", OWN)).text()).toBe(EDITOR_INDEX);
  });

  it("caches hashed build files for good and revalidates the rest", async () => {
    const hashed = await get("https://design.docs.test/designer/assets/main-abc.js", OWN);
    expect(await hashed.text()).toBe("editor()");
    expect(hashed.headers.get("Cache-Control")).toContain("immutable");
    const wasm = await get("https://design.docs.test/canvaskit.wasm", OWN);
    expect(await wasm.text()).toBe("wasm");
    expect(wasm.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("serves nothing else: no API, no MCP, no app pages or files", async () => {
    for (const path of [
      "/api/me",
      "/api/designs",
      "/mcp",
      "/d/abc",
      "/designs",
      "/assets/app.js",
      "/designer/missing.js",
    ]) {
      const response = await get(`https://design.docs.test${path}`, OWN);
      expect([path, response.status]).toEqual([path, 404]);
    }
    const post = await worker.fetch(
      new Request("https://design.docs.test/api/auth/password", {
        method: "POST",
        body: "{}",
      }) as never,
      env(OWN),
      ctx,
    );
    expect(post.status).toBe(405);
  });
});

describe("the app's host", () => {
  it("never serves the editor when it has an origin of its own", async () => {
    expect((await get("https://docs.test/designer/", OWN)).status).toBe(404);
    // The app's own pages never allow eval.
    for (const vars of [OWN, {}]) {
      const app = await get("https://docs.test/designs", vars);
      expect(app.status).toBe(200);
      expect(app.headers.get("Content-Security-Policy") ?? "").not.toContain("unsafe-eval");
    }
    expect((await get("https://docs.test/designer/assets/main-abc.js", OWN)).status).toBe(404);
  });

  it("serves the editor under /designer/ when no editor origin is set", async () => {
    const response = await get("https://docs.test/designer/?host=up-docs", {});
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(EDITOR_INDEX);
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'self' https://app.t3.codes",
    );
    // The app's origin never allows eval, also for the editor served on it.
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:",
    );
    expect(response.headers.get("Content-Security-Policy")).not.toContain("'unsafe-eval'");
    expect((await get("https://docs.test/designer", {})).status).toBe(302);
    // Still never the app's page for a missing editor file.
    expect((await get("https://docs.test/designer/missing.js", {})).status).toBe(404);
  });
});

describe("requests from the editor's origin to the app", () => {
  afterEach(() => void vi.useRealTimers());
  /** The real Worker with a database, a signed-in cookie, a doc and a sheet, and rooms that answer. */
  async function signedIn() {
    const api = makeApiHarness();
    // The real Worker reads Date.now(); keep it on the harness clock so the session is current.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(api.clock.now);
    const cookie = await api.signIn();
    const headers = { Cookie: cookie };
    const doc = (await (
      await api.call("POST", "/api/docs", { body: { title: "Plan" }, headers })
    ).json()) as {
      doc: { id: string };
    };
    const sheet = (await (
      await api.call("POST", "/api/sheets", { body: { title: "Numbers" }, headers })
    ).json()) as {
      sheet: { id: string };
    };
    /** What each room was sent, so a test can see what reached it. */
    const forwarded: Array<Request> = [];
    const room = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          forwarded.push(request);
          return new Response("room");
        },
      }),
    };
    const vars = {
      ...env(OWN),
      DB: api.db,
      DOC_ROOM: room,
      SHEET_ROOM: room,
      DESIGN_ROOM: room,
      OWNER_EMAILS: "owner@example.com, second@example.com",
    } as unknown as Env;
    const call = (path: string, origin: string, init: RequestInit = {}) =>
      worker.fetch(
        new Request(`https://docs.test${path}`, {
          ...init,
          headers: { Cookie: cookie, Origin: origin, ...(init.headers as Record<string, string>) },
        }) as never,
        vars,
        ctx,
      );
    return { call, forwarded, docId: doc.doc.id, sheetId: sheet.sheet.id };
  }
  const EDITOR = "https://design.docs.test";
  const APP = "https://docs.test";
  const socket = { headers: { Upgrade: "websocket" } };

  it("refuses them with 403 even with a valid session cookie: sockets, REST and pages", async () => {
    const { call, docId, sheetId } = await signedIn();
    const cases: Array<[string, RequestInit]> = [
      [`/api/docs/${docId}/ws`, socket],
      [`/api/sheets/${sheetId}/ws`, socket],
      ["/api/me", {}],
      [`/api/docs/${docId}`, { method: "DELETE" }],
      ["/designs", {}],
      ["/mcp", { method: "POST", body: "{}" }],
    ];
    for (const [path, init] of cases) {
      const response = await call(path, EDITOR, init);
      expect([path, response.status]).toEqual([path, 403]);
    }
    // The same requests from the app itself go through.
    expect(await (await call(`/api/docs/${docId}/ws`, APP, socket)).text()).toBe("room");
    expect(await (await call(`/api/sheets/${sheetId}/ws`, APP, socket)).text()).toBe("room");
    expect((await call("/api/me", APP)).status).toBe(200);
    expect((await call("/designs", APP)).status).toBe(200);
  });

  // Changed by S3, which serves the reserved path (designAgent.ts).
  it("leaves only the design agent socket, which takes a ticket and never the cookie", async () => {
    const { call, forwarded } = await signedIn();
    const path = designAgentSocketPath("abc123");
    const ticket = "a".repeat(64);
    // The socket route answers, not the guard: no ticket, no socket.
    expect(await (await call(path, EDITOR, socket)).text()).toBe("Ticket refused");
    expect((await call(`${path}?ticket=${ticket}`, EDITOR)).status).toBe(426);
    // Only the editor's origin opens it.
    expect((await call(`${path}?ticket=${ticket}`, APP, socket)).status).toBe(403);
    expect(forwarded).toHaveLength(0);
    expect(await (await call(`${path}?ticket=${ticket}`, EDITOR, socket)).text()).toBe("room");
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.headers.get("Cookie")).toBeNull();
    expect(new URL(forwarded[0]!.url).searchParams.get("ticket")).toBe(ticket);
    // Paths beside it stay the guard's.
    for (const near of [`${path}/x`, "/api/designs/abc123/agent-ticket", "/api/designs/abc123"]) {
      const response = await call(near, EDITOR, { ...socket, method: "GET" });
      expect([near, response.status, await response.text()]).toEqual([near, 403, "Forbidden"]);
    }
  });
});
