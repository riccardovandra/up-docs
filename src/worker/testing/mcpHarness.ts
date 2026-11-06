// The MCP endpoint driven like a real client, over the API test harness.

import { handleMcp } from "../mcp.ts";
import { makeApiHarness, ORIGIN } from "./apiHarness.ts";

/** `requestOrigin` stands in for what request.url reports, which can differ from PUBLIC_ORIGIN. */
export async function makeMcpHarness(requestOrigin = ORIGIN) {
  const api = makeApiHarness();
  const cookie = await api.signIn();
  const created = await api.call("POST", "/api/tokens", {
    body: { name: "agent" },
    headers: { Cookie: cookie },
  });
  const { token } = (await created.json()) as { token: string };
  let nextId = 1;
  // Echoed like a real client, once initialize hands one out.
  let sessionId: string | null = null;

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    handleMcp(
      new Request(`${requestOrigin}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      api.deps,
    );

  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await post(
      { jsonrpc: "2.0", id: nextId++, method, params },
      { Authorization: `Bearer ${token}`, ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) },
    );
    sessionId = response.headers.get("Mcp-Session-Id") ?? sessionId;
    return (await response.json()) as {
      result?: Record<string, unknown> & {
        content?: Array<{ text: string }>;
        isError?: boolean;
      };
      error?: { code: number; message: string };
    };
  };

  const tool = async (name: string, args: Record<string, unknown>) => {
    const { result } = await rpc("tools/call", { name, arguments: args });
    return {
      isError: result?.isError === true,
      body: JSON.parse(result!.content![0]!.text) as any,
    };
  };

  const seedDoc = async (markdown?: string) => {
    const project = await tool("create_project", { name: "Acme" });
    const doc = await tool("create_doc", {
      projectId: project.body.projectId,
      title: "Plan",
      ...(markdown === undefined ? {} : { markdown }),
    });
    return doc.body as { doc: { docId: string; url: string }; tab: { tabId: string } };
  };

  /** A tool caller acting as another person, signed in by email. */
  const asUser = async (email: string) => {
    const userCookie = await api.signIn(email);
    const created = await api.call("POST", "/api/tokens", {
      body: { name: `${email} agent` },
      headers: { Cookie: userCookie },
    });
    const { token: userToken } = (await created.json()) as { token: string };
    return async (name: string, args: Record<string, unknown>) => {
      const response = await post(
        { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } },
        { Authorization: `Bearer ${userToken}` },
      );
      const { result } = (await response.json()) as {
        result: { isError?: boolean; content: Array<{ text: string }> };
      };
      return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text) as any };
    };
  };

  return { api, cookie, token, post, rpc, tool, seedDoc, asUser };
}
