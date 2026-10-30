import { afterEach, describe, expect, it, vi } from "vitest";

import { emailDeliveryNotice, type DocMember, type Me } from "../shared/access.ts";
import type { DocWithTabs } from "../shared/protocol.ts";
import * as Access from "./access.ts";
import {
  ADMIN_LOGIN_MAX_ATTEMPTS,
  ADMIN_LOGIN_WINDOW_MS,
  createSession,
  parseOwnerEmails,
} from "./auth.ts";
import { emailEnabled, isLocalRequest, sendDocInvite, sendLoginCode } from "./email.ts";
import type { Env } from "./env.ts";
import { makeApiHarness, OWNER } from "./testing/apiHarness.ts";

const PASSWORD = "correct horse battery";
const noOwners = { owners: parseOwnerEmails(""), adminPassword: PASSWORD };
const signInBody = (password: unknown) => ({ body: { password } });

async function adminCookie(api: ReturnType<typeof makeApiHarness>): Promise<string> {
  const response = await api.call("POST", "/api/auth/password", signInBody(PASSWORD));
  expect(response.status).toBe(200);
  const cookie = response.headers.get("Set-Cookie");
  expect(cookie).toContain("HttpOnly; Secure; SameSite=None; Partitioned");
  return cookie!.split(";")[0]!;
}

async function newDoc(api: ReturnType<typeof makeApiHarness>, cookie: string): Promise<string> {
  const created = await api.call("POST", "/api/docs", {
    body: { title: "Plan" },
    headers: { Cookie: cookie },
  });
  expect(created.status).toBe(201);
  return ((await created.json()) as DocWithTabs).doc.id;
}

async function mcpCall(
  api: ReturnType<typeof makeApiHarness>,
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  const { handleMcp } = await import("./mcp.ts");
  const response = await handleMcp(
    new Request("https://docs.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    api.deps,
  );
  const { result } = (await response.json()) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text) as any };
}

describe("admin password sign-in", () => {
  it("signs in with the right password and refuses a wrong or missing one", async () => {
    const api = makeApiHarness(noOwners);
    const wrong = await api.call("POST", "/api/auth/password", signInBody("not the password!"));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("Set-Cookie")).toBeNull();
    for (const password of [undefined, "", 42]) {
      const missing = await api.call("POST", "/api/auth/password", signInBody(password));
      expect(missing.status).toBe(401);
    }
    const cookie = await adminCookie(api);
    const me = await api.call("GET", "/api/me", { headers: { Cookie: cookie } });
    expect(((await me.json()) as Me).user.id).toBe(Access.OWNER_USER_ID);
  });

  it("compares the password exactly", async () => {
    const api = makeApiHarness(noOwners);
    const padded = await api.call("POST", "/api/auth/password", signInBody(` ${PASSWORD} `));
    expect(padded.status).toBe(401);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["short", "elevenchars"],
    ["blank", "              "],
  ])("is off when ADMIN_PASSWORD is %s, even for that exact value", async (_name, value) => {
    const api = makeApiHarness({ ...noOwners, adminPassword: value });
    const config = await api.call("GET", "/api/auth/config");
    expect(await config.json()).toEqual({ emailEnabled: true, passwordEnabled: false });
    const response = await api.call("POST", "/api/auth/password", signInBody(value ?? "x"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "password_not_configured" });
    const row = await api.db.prepare("SELECT COUNT(*) AS n FROM admin_login_attempts").first();
    expect(row).toEqual({ n: 0 });
  });

  it("applies the same origin and JSON checks as the other auth routes", async () => {
    const api = makeApiHarness(noOwners);
    const foreign = await api.call("POST", "/api/auth/password", {
      ...signInBody(PASSWORD),
      headers: { Origin: "https://evil.test" },
    });
    expect(foreign.status).toBe(403);
    const form = await api.call("POST", "/api/auth/password", {
      ...signInBody(PASSWORD),
      headers: { "Content-Type": "text/plain" },
    });
    expect(form.status).toBe(403);
  });

  it("locks everyone out after the budget, even with the right password, then recovers", async () => {
    const api = makeApiHarness(noOwners);
    for (let attempt = 0; attempt < ADMIN_LOGIN_MAX_ATTEMPTS; attempt++) {
      const response = await api.call("POST", "/api/auth/password", signInBody("wrong password!"));
      expect(response.status).toBe(401);
    }
    const locked = await api.call("POST", "/api/auth/password", signInBody(PASSWORD));
    expect(locked.status).toBe(429);
    expect(await locked.json()).toEqual({ error: "too_many_attempts" });

    api.clock.now += ADMIN_LOGIN_WINDOW_MS - 1;
    const stillLocked = await api.call("POST", "/api/auth/password", signInBody(PASSWORD));
    expect(stillLocked.status).toBe(429);

    api.clock.now += 1;
    await adminCookie(api);
  });

  it("counts parallel guesses, so they cannot slip past the budget", async () => {
    const api = makeApiHarness(noOwners);
    const responses = await Promise.all(
      Array.from({ length: ADMIN_LOGIN_MAX_ATTEMPTS + 5 }, () =>
        api.call("POST", "/api/auth/password", signInBody("wrong password!")),
      ),
    );
    expect(responses.filter((response) => response.status === 401)).toHaveLength(
      ADMIN_LOGIN_MAX_ATTEMPTS,
    );
    expect(responses.filter((response) => response.status === 429)).toHaveLength(5);
  });

  it("clears the budget after a good sign-in", async () => {
    const api = makeApiHarness(noOwners);
    for (let attempt = 0; attempt < ADMIN_LOGIN_MAX_ATTEMPTS - 1; attempt++) {
      await api.call("POST", "/api/auth/password", signInBody("wrong password!"));
    }
    await adminCookie(api);
    const row = await api.db.prepare("SELECT COUNT(*) AS n FROM admin_login_attempts").first();
    expect(row).toEqual({ n: 0 });
  });
});

describe("the admin with no OWNER_EMAILS", () => {
  it("runs the whole token flow and owns what it creates", async () => {
    const api = makeApiHarness(noOwners);
    const cookie = await adminCookie(api);
    const as = { headers: { Cookie: cookie } };

    const me = (await (await api.call("GET", "/api/me", as)).json()) as Me;
    expect(me).toEqual({
      user: { id: Access.OWNER_USER_ID, name: "Owner", email: Access.ADMIN_SESSION_EMAIL },
      emails: [Access.ADMIN_SESSION_EMAIL],
    });
    const project = await api.call("POST", "/api/projects", { body: { name: "Acme" }, ...as });
    expect(project.status).toBe(201);
    const docId = await newDoc(api, cookie);

    const minted = await api.call("POST", "/api/tokens", { body: { name: "agent" }, ...as });
    expect(minted.status).toBe(201);
    const { token } = (await minted.json()) as { token: string };
    const read = await mcpCall(api, token, "read_doc", { docId });
    expect(read.isError).toBe(false);
    expect(read.body.doc.role).toBe("owner");

    const logout = await api.call("POST", "/api/auth/logout", { body: {}, ...as });
    expect(logout.status).toBe(200);
    expect((await api.call("GET", "/api/me", as)).status).toBe(401);
  });

  it("can edit a comment it wrote, with or without OWNER_EMAILS", async () => {
    for (const owners of [noOwners.owners, parseOwnerEmails(OWNER)]) {
      const api = makeApiHarness({ ...noOwners, owners });
      const cookie = await adminCookie(api);
      const as = { headers: { Cookie: cookie } };
      const created = await api.call("POST", "/api/docs", { body: { title: "Plan" }, ...as });
      const { tabs } = (await created.json()) as DocWithTabs;
      const tab = tabs[0]!;
      await api.call("PATCH", `/api/tabs/${tab.id}`, {
        body: { baseVersion: tab.version, markdown: "Some text" },
        ...as,
      });
      const commented = await api.call("POST", `/api/tabs/${tab.id}/comments`, {
        body: { quote: "Some", body: "Hello" },
        ...as,
      });
      expect(commented.status).toBe(201);
      const { comment } = (await commented.json()) as { comment: { id: string } };
      const edited = await api.call("PATCH", `/api/comments/${comment.id}`, {
        body: { body: "Hello again" },
        ...as,
      });
      expect(edited.status).toBe(200);
    }
  });

  it("keeps working next to OWNER_EMAILS as the same admin", async () => {
    const api = makeApiHarness({ adminPassword: PASSWORD });
    const viaEmail = await api.signIn();
    await newDoc(api, viaEmail);
    const viaPassword = await adminCookie(api);
    const library = await api.call("GET", "/api/library", { headers: { Cookie: viaPassword } });
    expect(JSON.stringify(await library.json())).toContain('"role":"owner"');
    const me = await api.call("GET", "/api/me", { headers: { Cookie: viaPassword } });
    expect(((await me.json()) as Me).user.email).toBe(OWNER);
  });

  it("keeps a session across a password change", async () => {
    const api = makeApiHarness(noOwners);
    const cookie = await adminCookie(api);
    const rotated = { ...api.deps, adminPassword: "a different password" };
    const { handleApi } = await import("./api.ts");
    const me = await handleApi(
      new Request("https://docs.test/api/me", { headers: { Cookie: cookie } }),
      rotated,
    );
    expect(me.status).toBe(200);
  });
});

describe("the reserved admin address", () => {
  const reserved = [
    Access.ADMIN_SESSION_EMAIL,
    Access.ADMIN_SESSION_EMAIL.toUpperCase(),
    `  ${Access.ADMIN_SESSION_EMAIL} `,
  ];

  it.each(reserved)("cannot get a code: %j", async (email) => {
    const api = makeApiHarness(noOwners);
    const response = await api.call("POST", "/api/auth/request-code", { body: { email } });
    expect(await response.json()).toEqual({ ok: true });
    expect(api.sentCodes).toEqual([]);
    const row = await api.db.prepare("SELECT COUNT(*) AS n FROM login_codes").first();
    expect(row).toEqual({ n: 0 });
  });

  it("cannot get a code even when listed in OWNER_EMAILS", async () => {
    const api = makeApiHarness({ owners: parseOwnerEmails(Access.ADMIN_SESSION_EMAIL) });
    await api.call("POST", "/api/auth/request-code", {
      body: { email: Access.ADMIN_SESSION_EMAIL },
    });
    expect(api.sentCodes).toEqual([]);
  });

  it("cannot verify a stored code or a pending invite", async () => {
    const api = makeApiHarness(noOwners);
    const cookie = await adminCookie(api);
    const docId = await newDoc(api, cookie);
    // Rows no route can write: they must still not open the door.
    await api.db
      .prepare(
        `INSERT INTO doc_members (id, doc_id, user_id, email, role, added_by, created_at)
         VALUES ('m', ?, NULL, ?, 'viewer', 'owner', 1)`,
      )
      .bind(docId, Access.ADMIN_SESSION_EMAIL)
      .run();
    await api.db
      .prepare(
        `INSERT INTO login_codes (email, code_hash, expires_at, attempts, created_at)
         VALUES (?, 'x', ?, 0, 1)`,
      )
      .bind(Access.ADMIN_SESSION_EMAIL, api.clock.now + 60_000)
      .run();
    await api.call("POST", "/api/auth/request-code", {
      body: { email: Access.ADMIN_SESSION_EMAIL },
    });
    expect(api.sentCodes).toEqual([]);
    const verify = await api.call("POST", "/api/auth/verify", {
      body: { email: Access.ADMIN_SESSION_EMAIL, code: "000000" },
    });
    expect(verify.status).toBe(401);
  });

  it("cannot be invited through the API or MCP, by anyone", async () => {
    const api = makeApiHarness({ adminPassword: PASSWORD });
    const owner = await api.signIn();
    const docId = await newDoc(api, owner);
    const shared = await api.call("POST", `/api/docs/${docId}/members`, {
      body: { email: "guest@example.com", role: "owner" },
      headers: { Cookie: owner },
    });
    expect(shared.status).toBe(201);
    const guest = await api.signIn("guest@example.com");

    for (const email of reserved) {
      for (const cookie of [owner, guest]) {
        const response = await api.call("POST", `/api/docs/${docId}/members`, {
          body: { email, role: "viewer" },
          headers: { Cookie: cookie },
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "invalid_email" });
      }
    }
    const minted = await api.call("POST", "/api/tokens", {
      body: { name: "agent" },
      headers: { Cookie: owner },
    });
    const { token } = (await minted.json()) as { token: string };
    const viaMcp = await mcpCall(api, token, "share_doc", {
      docId,
      email: Access.ADMIN_SESSION_EMAIL,
      role: "viewer",
    });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.body.error).toBe("invalid_argument");
    expect(api.invites.map((invite) => invite.to)).toEqual(["guest@example.com"]);
  });

  it("stays out of share suggestions", async () => {
    const api = makeApiHarness(noOwners);
    const admin = await adminCookie(api);
    const docId = await newDoc(api, admin);
    await api.call("POST", `/api/docs/${docId}/members`, {
      body: { email: "guest@example.com", role: "editor" },
      headers: { Cookie: admin },
    });
    const guest = await api.signIn("guest@example.com").catch(() => null);
    expect(guest).not.toBeNull();
    const people = await api.call("GET", "/api/people", { headers: { Cookie: guest! } });
    expect(await people.json()).toEqual({ people: [] });
  });

  it("treats a session for any other unknown address as nobody", async () => {
    const api = makeApiHarness(noOwners);
    const token = await createSession(api.db, "someone@example.com", api.clock.now);
    const me = await api.call("GET", "/api/me", {
      headers: { Cookie: `docs_session=${token}` },
    });
    expect(me.status).toBe(401);
  });
});

describe("sign-in config", () => {
  it.each([
    [true, PASSWORD, { emailEnabled: true, passwordEnabled: true }],
    [true, undefined, { emailEnabled: true, passwordEnabled: false }],
    [false, PASSWORD, { emailEnabled: false, passwordEnabled: true }],
    [false, undefined, { emailEnabled: false, passwordEnabled: false }],
  ])("email %s, password %s", async (enabled, adminPassword, expected) => {
    const api = makeApiHarness({ emailEnabled: enabled, adminPassword });
    const response = await api.call("GET", "/api/auth/config");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
  });

  it("refuses to issue a code when email cannot be sent, for any address", async () => {
    const api = makeApiHarness({ emailEnabled: false });
    for (const email of [OWNER, "stranger@example.com"]) {
      const response = await api.call("POST", "/api/auth/request-code", { body: { email } });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "email_not_configured" });
    }
    expect(api.sentCodes).toEqual([]);
  });
});

describe("email delivery", () => {
  afterEach(() => vi.unstubAllGlobals());
  const env = (key?: string) =>
    ({ EMAIL_FROM: "x@example.com", ...(key ? { RESEND_API_KEY: key } : {}) }) as unknown as Env;
  const invite = { to: "g@example.com", inviterName: "A", docTitle: "T", url: "https://x.test" };

  it("tells local dev from a deployed host by the request URL", () => {
    expect(isLocalRequest(new Request("http://localhost:8787/api/x"))).toBe(true);
    expect(isLocalRequest(new Request("http://127.0.0.1:8787/api/x"))).toBe(true);
    expect(isLocalRequest(new Request("http://[::1]:8787/api/x"))).toBe(true);
    expect(isLocalRequest(new Request("https://up-docs.acme.workers.dev/api/x"))).toBe(false);
    expect(isLocalRequest(new Request("https://localhost.evil.test/api/x"))).toBe(false);
    expect(emailEnabled(env(), false)).toBe(false);
    expect(emailEnabled(env(), true)).toBe(true);
    expect(emailEnabled(env("key"), false)).toBe(true);
  });

  it("never logs a code away from localhost, and does log it there", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await sendLoginCode(env(), false, "a@example.com", "123456")).toBe("not_configured");
    expect(log).not.toHaveBeenCalled();
    expect(await sendLoginCode(env(), true, "a@example.com", "123456")).toBe("sent");
    expect(log.mock.calls.join()).toContain("123456");
    log.mockRestore();
  });

  it("counts a missing or blank EMAIL_FROM as not configured, and calls nothing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const send = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", send);
    for (const from of [undefined, "", "  "]) {
      const noSender = { RESEND_API_KEY: "key", EMAIL_FROM: from } as unknown as Env;
      expect(emailEnabled(noSender, false)).toBe(false);
      expect(await sendLoginCode(noSender, false, "a@example.com", "123456")).toBe(
        "not_configured",
      );
      expect(await sendDocInvite(noSender, false, invite)).toBe("not_configured");
    }
    expect(send).not.toHaveBeenCalled();
    expect(error.mock.calls.join()).toContain("EMAIL_FROM");
    expect(error.mock.calls.join()).not.toContain("123456");
    error.mockRestore();
  });

  it("works with neither EMAIL_FROM nor RESEND_API_KEY defined", async () => {
    const unset = {} as unknown as Env;
    expect(emailEnabled(unset, false)).toBe(false);
    expect(await sendDocInvite(unset, false, invite)).toBe("not_configured");
  });

  it("reports a Resend rejection without logging the code", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 422 }));
    expect(await sendLoginCode(env("key"), false, "a@example.com", "123456")).toBe("failed");
    expect(await sendDocInvite(env("key"), false, invite)).toBe("failed");
    expect(error.mock.calls.join()).not.toContain("123456");
    error.mockRestore();
  });

  it("reports an unreachable Resend as failed, and a good send as sent", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", async () => {
      throw new Error("network");
    });
    expect(await sendDocInvite(env("key"), false, invite)).toBe("failed");
    vi.stubGlobal("fetch", async () => new Response("{}"));
    expect(await sendDocInvite(env("key"), false, invite)).toBe("sent");
    error.mockRestore();
  });
});

describe("sharing and email", () => {
  async function sharedDoc() {
    const api = makeApiHarness(noOwners);
    const cookie = await adminCookie(api);
    const docId = await newDoc(api, cookie);
    const share = (email: string) =>
      api.call("POST", `/api/docs/${docId}/members`, {
        body: { email, role: "editor" },
        headers: { Cookie: cookie },
      });
    const minted = await api.call("POST", "/api/tokens", {
      body: { name: "agent" },
      headers: { Cookie: cookie },
    });
    const { token } = (await minted.json()) as { token: string };
    return { api, docId, share, token };
  }
  type Shared = { member: DocMember; members: Array<DocMember>; emailDelivery: string | null };

  it("says the email went out", async () => {
    const { api, share } = await sharedDoc();
    const response = await share("guest@example.com");
    expect(response.status).toBe(201);
    expect(((await response.json()) as Shared).emailDelivery).toBe("sent");
    expect(api.invites).toHaveLength(1);
  });

  it.each(["not_configured", "failed"] as const)(
    "records the member and reports %s",
    async (delivery) => {
      const { api, share } = await sharedDoc();
      api.mail.delivery = delivery;
      const response = await share("guest@example.com");
      expect(response.status).toBe(201);
      const body = (await response.json()) as Shared;
      expect(body.emailDelivery).toBe(delivery);
      expect(body.members.map((member) => member.email)).toContain("guest@example.com");
    },
  );

  it("reports nothing on a role change, where no email is due", async () => {
    const { api, share } = await sharedDoc();
    await share("guest@example.com");
    const again = await share("guest@example.com");
    expect(again.status).toBe(200);
    expect(((await again.json()) as Shared).emailDelivery).toBeNull();
    expect(api.invites).toHaveLength(1);
  });

  it("tells an MCP caller the same, with the doc link", async () => {
    const { api, docId, token } = await sharedDoc();
    const sent = await mcpCall(api, token, "share_doc", {
      docId,
      email: "a@example.com",
      role: "viewer",
    });
    expect(sent.body).toMatchObject({ added: true, emailSent: true });
    expect(sent.body.notice).toBeUndefined();

    api.mail.delivery = "not_configured";
    const unsent = await mcpCall(api, token, "share_doc", {
      docId,
      email: "b@example.com",
      role: "viewer",
    });
    expect(unsent.isError).toBe(false);
    expect(unsent.body).toMatchObject({
      added: true,
      emailSent: false,
      docUrl: `https://docs.test/d/${docId}`,
    });
    expect(unsent.body.notice).toContain("cannot sign in until email is configured");

    api.mail.delivery = "failed";
    const failed = await mcpCall(api, token, "share_doc", {
      docId,
      email: "c@example.com",
      role: "viewer",
    });
    expect(failed.body.emailSent).toBe(false);
    expect(failed.body.notice).toContain("did not accept");
  });

  it("words each outcome plainly", () => {
    expect(emailDeliveryNotice("sent", "a@b.c")).toBeNull();
    expect(emailDeliveryNotice("not_configured", "a@b.c")).toContain("RESEND_API_KEY");
    expect(emailDeliveryNotice("failed", "a@b.c")).toContain("No email was sent to a@b.c");
  });
});
