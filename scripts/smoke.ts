#!/usr/bin/env bun
// End-to-end check of a deployed UP Docs: sign-in, docs, images, videos, tokens,
// /mcp and sharing. Removes what it creates. Run against a test deployment.
//   ADMIN_PASSWORD=... bun scripts/smoke.ts https://up-docs.example.workers.dev
// Prints a line per step and never prints the password, the session or a token.

import { createHash } from "node:crypto";

const base = process.argv[2]?.replace(/\/+$/, "");
const password = process.env.ADMIN_PASSWORD;
if (!base || !URL.canParse(base) || !password) {
  console.error(
    "Usage: ADMIN_PASSWORD=<password> bun scripts/smoke.ts <base-url>",
  );
  process.exit(2);
}

// A real 1x1 PNG.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);
// The leading bytes of an MP4, enough to pass the upload check.
const MP4 = new TextEncoder().encode("\0\0\0\x18ftypisom\0\0\x02\0isomiso2");
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

class StepFailure extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new StepFailure(message);
}

let session = "";
let token = "";

/** Calls the API with the session. Failure messages name the status and error code only. */
async function api(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Cookie: session,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  check(
    response.ok,
    `${method} ${path}: ${response.status} ${data.error ?? ""}`.trim(),
  );
  return data;
}

let rpcId = 0;
let mcpSession: string | null = null;

async function mcp(
  method: string,
  params: Record<string, unknown>,
): Promise<any> {
  rpcId += 1;
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(mcpSession ? { "Mcp-Session-Id": mcpSession } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
  });
  check(response.ok, `/mcp ${method}: ${response.status}`);
  mcpSession = response.headers.get("Mcp-Session-Id") ?? mcpSession;
  const data = (await response.json()) as {
    result?: any;
    error?: { code: number };
  };
  check(
    data.result,
    `/mcp ${method}: JSON-RPC error ${data.error?.code ?? "unknown"}`,
  );
  return data.result;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const result = await mcp("tools/call", { name, arguments: args });
  check(!result.isError, `/mcp ${name}: tool error`);
  return JSON.parse(result.content[0].text);
}

let failures = 0;

async function step(name: string, run: () => Promise<void>): Promise<boolean> {
  try {
    await run();
    console.log(`PASS ${name}`);
    return true;
  } catch (cause) {
    failures += 1;
    const known = cause instanceof StepFailure;
    console.log(`FAIL ${name}: ${known ? cause.message : "unexpected error"}`);
    return false;
  }
}

let docId = "";
let tabId = "";
let version = 0;
let imageUrl = "";
let videoUrl = "";
let tokenId = "";
const original = "# Smoke\n\nmcp-placeholder\n";
const edited = `${original}\nEdited through the API.\n`;

async function mainFlow(): Promise<void> {
  const signedIn = await step("sign in as admin", async () => {
    const response = await fetch(`${base}/api/auth/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    check(response.ok, `${response.status} ${data.error ?? ""}`.trim());
    const cookie = response.headers
      .getSetCookie()
      .find((c) => c.startsWith("docs_session="));
    check(cookie, "no session cookie");
    session = cookie.split(";")[0]!;
    await api("GET", "/api/me");
  });
  if (!signedIn) return;

  const created = await step("create doc", async () => {
    const data = await api("POST", "/api/docs", {
      title: "UP Docs smoke test",
    });
    docId = data.doc.id;
    tabId = data.tabs[0].id;
    version = data.tabs[0].version;
    check(docId && tabId, "no doc or tab id");
  });
  if (!created) return;

  await step("edit doc", async () => {
    const seeded = await api("PATCH", `/api/tabs/${tabId}`, {
      baseVersion: version,
      markdown: edited,
    });
    version = seeded.tab.version;
  });

  await step("read doc back", async () => {
    const { tab } = await api("GET", `/api/tabs/${tabId}`);
    check(tab.markdown === edited, "markdown differs from what was written");
  });

  const uploaded = await step("upload PNG", async () => {
    const response = await fetch(`${base}/api/docs/${docId}/images`, {
      method: "POST",
      headers: { Cookie: session, "Content-Type": "image/png" },
      body: PNG,
    });
    const data = (await response.json().catch(() => ({}))) as {
      url?: string;
      error?: string;
    };
    check(
      response.ok && data.url,
      `${response.status} ${data.error ?? ""}`.trim(),
    );
    imageUrl = data.url;
  });

  if (uploaded) {
    await step("fetch PNG back, hash matches", async () => {
      const response = await fetch(`${base}${imageUrl}`, {
        headers: { Cookie: session },
      });
      check(response.ok, `${response.status}`);
      check(
        response.headers.get("Content-Type") === "image/png",
        "wrong content type",
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      check(sha256(bytes) === sha256(PNG), "hash differs");
    });
  }

  const videoUploaded = await step("upload MP4 in parts", async () => {
    const started = await api("POST", `/api/docs/${docId}/videos`, {
      type: "video/mp4",
      size: MP4.length,
    });
    const path = `/api/docs/${docId}/videos/${started.file}`;
    const query = `uploadId=${encodeURIComponent(started.uploadId)}&part=1`;
    const response = await fetch(`${base}${path}?${query}`, {
      method: "PUT",
      headers: { Cookie: session },
      body: MP4,
    });
    const part = (await response.json().catch(() => ({}))) as {
      etag?: string;
      error?: string;
    };
    check(
      response.ok && part.etag,
      `${response.status} ${part.error ?? ""}`.trim(),
    );
    const done = await api("POST", path, {
      uploadId: started.uploadId,
      parts: [{ partNumber: 1, etag: part.etag }],
    });
    videoUrl = done.url;
    check(videoUrl, "no video URL");
  });

  if (videoUploaded) {
    await step("fetch MP4 back, hash matches", async () => {
      const response = await fetch(`${base}${videoUrl}`, {
        headers: { Cookie: session },
      });
      check(response.ok, `${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      check(sha256(bytes) === sha256(MP4), "hash differs");
    });
    await step("fetch a range of the MP4", async () => {
      const response = await fetch(`${base}${videoUrl}`, {
        headers: { Cookie: session, Range: "bytes=4-7" },
      });
      check(response.status === 206, `${response.status}`);
      const text = new TextDecoder().decode(await response.arrayBuffer());
      check(text === "ftyp", "wrong bytes");
    });
  }

  const hasToken = await step("create API token", async () => {
    const data = await api("POST", "/api/tokens", { name: "smoke" });
    tokenId = data.id;
    token = data.token;
    check(tokenId && token, "no token returned");
  });

  if (hasToken) {
    const ready = await step("mcp initialize", async () => {
      const result = await mcp("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "up-docs-smoke", version: "1" },
      });
      check(result.serverInfo?.name, "no serverInfo");
    });
    if (ready) {
      await step("mcp tools/list", async () => {
        const { tools } = await mcp("tools/list", {});
        const names = tools.map((tool: { name: string }) => tool.name);
        check(
          names.includes("read_doc") && names.includes("edit_tab"),
          "tools missing",
        );
      });
      await step("mcp read tool (read_doc)", async () => {
        const result = await callTool("read_doc", { docId, tabId });
        check(
          JSON.stringify(result).includes("mcp-placeholder"),
          "doc text missing",
        );
      });
      await step("mcp write tool (edit_tab)", async () => {
        await callTool("edit_tab", {
          tabId,
          find: "mcp-placeholder",
          replace: "mcp-edited",
        });
        const { tab } = await api("GET", `/api/tabs/${tabId}`);
        check(
          tab.markdown.includes("mcp-edited"),
          "edit not visible through the API",
        );
      });
    }
  }

  await step("sharing reports no email sent", async () => {
    const config = await api("GET", "/api/auth/config");
    check(
      !config.emailEnabled,
      "email is configured here, so this check cannot run",
    );
    const data = await api("POST", `/api/docs/${docId}/members`, {
      email: "smoke-guest@example.com",
      role: "viewer",
    });
    check(
      data.emailDelivery === "not_configured",
      `emailDelivery is ${data.emailDelivery}`,
    );
  });
}

async function cleanUp(): Promise<void> {
  if (docId) {
    await step("delete doc", async () => {
      await api("DELETE", `/api/docs/${docId}`);
      if (imageUrl) {
        const gone = await fetch(`${base}${imageUrl}`, {
          headers: { Cookie: session },
        });
        check(gone.status === 404, `image still answers ${gone.status}`);
      }
      if (videoUrl) {
        const gone = await fetch(`${base}${videoUrl}`, {
          headers: { Cookie: session },
        });
        check(gone.status === 404, `video still answers ${gone.status}`);
      }
    });
  }
  if (tokenId) {
    await step("revoke token", async () => {
      await api("DELETE", `/api/tokens/${tokenId}`);
      const refused = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" }),
      });
      check(refused.status === 401, `revoked token answers ${refused.status}`);
    });
  }
}

await mainFlow();
await cleanUp();
console.log(failures === 0 ? "RESULT pass" : `RESULT fail (${failures})`);
process.exit(failures === 0 ? 0 : 1);
