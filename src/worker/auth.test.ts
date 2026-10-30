import { describe, expect, it } from "vitest";

import {
  issueLoginCode,
  LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_CODE_RESEND_INTERVAL_MS,
  LOGIN_CODE_TTL_MS,
  parseOwnerEmails,
  verifyLoginCode,
} from "./auth.ts";
import { makeApiHarness, OWNER } from "./testing/apiHarness.ts";
import { makeTestD1 } from "./testing/sqliteD1.ts";

const owners = parseOwnerEmails(`${OWNER},Second@Example.com`);

describe("parseOwnerEmails", () => {
  it("is empty when OWNER_EMAILS is undefined or blank", () => {
    expect(parseOwnerEmails(undefined).size).toBe(0);
    expect(parseOwnerEmails("").size).toBe(0);
    expect(parseOwnerEmails(" , ").size).toBe(0);
  });
});

describe("login codes", () => {
  it("signs in any allowlisted email, ignoring case and whitespace", async () => {
    const db = makeTestD1();
    const code = await issueLoginCode(db, { email: " SECOND@example.com ", owners, now: 0 });
    expect(code).toMatch(/^\d{6}$/);
    const session = await verifyLoginCode(db, {
      email: "second@example.com",
      code: code!,
      owners,
      now: 1,
    });
    expect(session).toEqual(expect.any(String));
  });

  it("issues nothing for an email outside the allowlist", async () => {
    const db = makeTestD1();
    expect(await issueLoginCode(db, { email: "stranger@example.com", owners, now: 0 })).toBeNull();
    const row = await db
      .prepare("SELECT COUNT(*) AS count FROM login_codes")
      .first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it("rejects a code after it expires", async () => {
    const db = makeTestD1();
    const code = await issueLoginCode(db, { email: OWNER, owners, now: 0 });
    expect(
      await verifyLoginCode(db, { email: OWNER, code: code!, owners, now: LOGIN_CODE_TTL_MS }),
    ).toBeNull();
  });

  it("burns the code once the attempt limit is reached", async () => {
    const db = makeTestD1();
    const code = (await issueLoginCode(db, { email: OWNER, owners, now: 0 }))!;
    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < LOGIN_CODE_MAX_ATTEMPTS; attempt++) {
      expect(await verifyLoginCode(db, { email: OWNER, code: wrong, owners, now: 1 })).toBeNull();
    }
    expect(await verifyLoginCode(db, { email: OWNER, code, owners, now: 1 })).toBeNull();
  });

  it("accepts a code only once", async () => {
    const db = makeTestD1();
    const code = (await issueLoginCode(db, { email: OWNER, owners, now: 0 }))!;
    expect(await verifyLoginCode(db, { email: OWNER, code, owners, now: 1 })).not.toBeNull();
    expect(await verifyLoginCode(db, { email: OWNER, code, owners, now: 2 })).toBeNull();
  });

  it("keeps the first code when asked again within the resend interval", async () => {
    const db = makeTestD1();
    const first = (await issueLoginCode(db, { email: OWNER, owners, now: 0 }))!;
    expect(await issueLoginCode(db, { email: OWNER, owners, now: 1 })).toBeNull();
    const second = await issueLoginCode(db, {
      email: OWNER,
      owners,
      now: LOGIN_CODE_RESEND_INTERVAL_MS,
    });
    expect(second).toMatch(/^\d{6}$/);
    if (second !== first) {
      expect(
        await verifyLoginCode(db, {
          email: OWNER,
          code: first,
          owners,
          now: LOGIN_CODE_RESEND_INTERVAL_MS + 1,
        }),
      ).toBeNull();
    }
  });
});

describe("sign-in API", () => {
  it("answers owners and strangers identically and only emails owners", async () => {
    const api = makeApiHarness();
    const owner = await api.call("POST", "/api/auth/request-code", { body: { email: OWNER } });
    const stranger = await api.call("POST", "/api/auth/request-code", {
      body: { email: "stranger@example.com" },
    });
    expect([owner.status, await owner.text()]).toEqual([stranger.status, await stranger.text()]);
    expect(api.sentCodes.map((entry) => entry.email)).toEqual([OWNER]);

    const failed = await api.call("POST", "/api/auth/verify", {
      body: { email: "stranger@example.com", code: "123456" },
    });
    expect(failed.status).toBe(401);
  });

  it("sets a session cookie that works inside an iframe", async () => {
    const api = makeApiHarness();
    await api.call("POST", "/api/auth/request-code", { body: { email: OWNER } });
    const response = await api.call("POST", "/api/auth/verify", {
      body: { email: OWNER, code: api.sentCodes[0]!.code },
    });
    const cookie = response.headers.get("Set-Cookie") ?? "";
    for (const flag of ["HttpOnly", "Secure", "SameSite=None", "Partitioned"]) {
      expect(cookie).toContain(flag);
    }
    const me = await api.call("GET", "/api/me", { headers: { Cookie: cookie.split(";")[0]! } });
    expect(await me.json()).toMatchObject({ user: { id: "owner", email: OWNER } });
  });

  it("ends the session on logout", async () => {
    const api = makeApiHarness();
    const cookie = await api.signIn();
    await api.call("POST", "/api/auth/logout", { body: {}, headers: { Cookie: cookie } });
    expect((await api.call("GET", "/api/me", { headers: { Cookie: cookie } })).status).toBe(401);
  });
});
