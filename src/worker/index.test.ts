import { afterEach, describe, expect, it, vi } from "vitest";

import { PUBLIC_ORIGIN_META } from "../shared/embed.ts";
import { OWNER, makeApiHarness } from "./testing/apiHarness.ts";
import type { Env } from "./env.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const WORKERS_DEV = "https://up-docs.example.workers.dev";
const PUBLIC_ORIGIN = "https://docs.example.com";

/** Runs the real fetch handler, so these cover how PUBLIC_ORIGIN reaches each surface. */
async function makeWorker(publicOrigin?: string) {
  const { default: worker } = await import("./index.ts");
  const api = makeApiHarness();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const env = {
    DB: api.db,
    ASSETS: {
      fetch: async () =>
        new Response("<html><head></head></html>", {
          headers: { "Content-Type": "text/html" },
        }),
    },
    OWNER_EMAILS: OWNER,
    EMAIL_FROM: "UP Docs <docs@example.com>",
    FRAME_ANCESTORS: "https://app.t3.codes",
    ...(publicOrigin === undefined ? {} : { PUBLIC_ORIGIN: publicOrigin }),
  } as unknown as Env;
  const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
  const fetch = (url: string, init?: RequestInit) =>
    worker.fetch(new Request(url, init) as never, env, ctx);
  const requestCode = (origin: string) =>
    fetch(`${WORKERS_DEV}/api/auth/request-code`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ email: OWNER }),
    });
  const metaOrigin = async () => {
    const html = await (await fetch(`${WORKERS_DEV}/`)).text();
    return html.match(new RegExp(`name="${PUBLIC_ORIGIN_META}" content="([^"]*)"`))?.[1];
  };
  const mcpDocUrl = async () => {
    const cookie = await api.signIn();
    const headers = { Cookie: cookie };
    const created = await api.call("POST", "/api/tokens", { body: { name: "agent" }, headers });
    const { token } = (await created.json()) as { token: string };
    await api.call("POST", "/api/docs", { body: { title: "Plan" }, headers });
    const response = await fetch(`${WORKERS_DEV}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_docs", arguments: {} },
      }),
    });
    const { result } = (await response.json()) as { result: { content: Array<{ text: string }> } };
    const { docs } = JSON.parse(result.content[0]!.text) as { docs: Array<{ url: string }> };
    return docs[0]!.url;
  };
  return { requestCode, metaOrigin, mcpDocUrl };
}

describe("worker with PUBLIC_ORIGIN unset", () => {
  afterEach(() => void vi.restoreAllMocks());

  it("puts the request's origin in the embed meta", async () => {
    const { metaOrigin } = await makeWorker();
    expect(await metaOrigin()).toBe(WORKERS_DEV);
  });

  it("accepts cookie writes from the request's origin and rejects others", async () => {
    const { requestCode } = await makeWorker();
    expect((await requestCode(WORKERS_DEV)).status).not.toBe(403);
    expect((await requestCode("https://evil.test")).status).toBe(403);
    expect((await requestCode(PUBLIC_ORIGIN)).status).toBe(403);
  });

  it("hands agents URLs on the request's origin", async () => {
    const { mcpDocUrl } = await makeWorker();
    expect(await mcpDocUrl()).toMatch(new RegExp(`^${WORKERS_DEV}/d/`));
  });
});

describe("worker with PUBLIC_ORIGIN set", () => {
  afterEach(() => void vi.restoreAllMocks());

  it("puts PUBLIC_ORIGIN in the embed meta", async () => {
    const { metaOrigin } = await makeWorker(PUBLIC_ORIGIN);
    expect(await metaOrigin()).toBe(PUBLIC_ORIGIN);
  });

  it("accepts cookie writes from PUBLIC_ORIGIN and the request's origin", async () => {
    const { requestCode } = await makeWorker(PUBLIC_ORIGIN);
    expect((await requestCode(PUBLIC_ORIGIN)).status).not.toBe(403);
    expect((await requestCode(WORKERS_DEV)).status).not.toBe(403);
    expect((await requestCode("https://evil.test")).status).toBe(403);
  });

  it("hands agents URLs on PUBLIC_ORIGIN", async () => {
    const { mcpDocUrl } = await makeWorker(PUBLIC_ORIGIN);
    expect(await mcpDocUrl()).toMatch(new RegExp(`^${PUBLIC_ORIGIN}/d/`));
  });
});
