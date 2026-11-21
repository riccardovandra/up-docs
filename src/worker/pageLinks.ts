// One-time links that move a page's HTML file between an agent's machine and
// the library (prepare_page_upload, read_page {downloadLink: true}). A 200 KB
// page typed into a tool call is about 60,000 tokens; a link sends it with
// curl in under a second. The shape of drawioLinks.ts, in page_link_tokens.

import { randomToken, sha256Hex } from "./crypto.ts";

/** How long a page upload or download link works. */
export const PAGE_LINK_TTL_MS = 10 * 60 * 1000;

export type PageLinkTool = "create_page" | "update_page" | "download";

export interface PageLinkClaim {
  readonly tool: PageLinkTool;
  readonly userId: string;
  readonly apiTokenId: string;
  readonly agentName: string;
  readonly args: Record<string, unknown>;
  /** Gives the link back, so a refused file can be fixed and sent again. */
  readonly release: () => Promise<void>;
}

export async function createPageLink(
  db: D1Database,
  input: {
    readonly tool: PageLinkTool;
    readonly userId: string;
    readonly apiTokenId: string;
    readonly agentName: string;
    readonly args: Record<string, unknown>;
    readonly now: number;
  },
): Promise<{ readonly token: string; readonly expiresAt: number }> {
  const token = randomToken();
  const expiresAt = input.now + PAGE_LINK_TTL_MS;
  await db.batch([
    db.prepare("DELETE FROM page_link_tokens WHERE expires_at < ?1").bind(input.now),
    db
      .prepare(
        `INSERT INTO page_link_tokens
           (token_hash, tool, user_id, api_token_id, agent_name, args_json, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        await sha256Hex(token),
        input.tool,
        input.userId,
        input.apiTokenId,
        input.agentName,
        JSON.stringify(input.args),
        expiresAt,
      ),
  ]);
  return { token, expiresAt };
}

/**
 * Claims an unused, unexpired link of one kind whose API token is still live,
 * so a second request with it fails. Returns null otherwise.
 */
export async function claimPageLink(
  db: D1Database,
  input: { readonly token: string; readonly kind: "upload" | "download"; readonly now: number },
): Promise<PageLinkClaim | null> {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.token)) return null;
  const hash = await sha256Hex(input.token);
  const toolMatch =
    input.kind === "download" ? "tool = 'download'" : "tool IN ('create_page', 'update_page')";
  const row = await db
    .prepare(
      `UPDATE page_link_tokens SET used_at = ?2
       WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2 AND ${toolMatch}
         AND EXISTS (SELECT 1 FROM api_tokens t
                     WHERE t.id = page_link_tokens.api_token_id AND t.revoked_at IS NULL)
       RETURNING tool, user_id, api_token_id, agent_name, args_json`,
    )
    .bind(hash, input.now)
    .first<{
      tool: PageLinkTool;
      user_id: string;
      api_token_id: string;
      agent_name: string;
      args_json: string;
    }>();
  if (!row) return null;
  return {
    tool: row.tool,
    userId: row.user_id,
    apiTokenId: row.api_token_id,
    agentName: row.agent_name,
    args: JSON.parse(row.args_json) as Record<string, unknown>,
    release: async () => {
      await db.prepare("UPDATE page_link_tokens SET used_at = NULL WHERE token_hash = ?1").bind(hash).run();
    },
  };
}
