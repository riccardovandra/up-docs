// One-time links that move a Draw.io file between an agent's machine and the
// library. Writing a diagram's XML into a tool call makes the model type every
// character: a 200 KB file is about 60,000 tokens and many minutes. With a link
// the agent sends or saves the file with curl in under a second.

import { randomToken, sha256Hex } from "./crypto.ts";

/** How long a Draw.io upload or download link works. */
export const DRAWIO_LINK_TTL_MS = 10 * 60 * 1000;

export type DrawioLinkTool = "create_drawio" | "update_drawio" | "download";

export interface DrawioLinkClaim {
  readonly tool: DrawioLinkTool;
  readonly userId: string;
  readonly apiTokenId: string;
  readonly agentName: string;
  readonly args: Record<string, unknown>;
  /** Gives the link back, so a refused file can be fixed and sent again. */
  readonly release: () => Promise<void>;
}

export async function createDrawioLink(
  db: D1Database,
  input: {
    readonly tool: DrawioLinkTool;
    readonly userId: string;
    readonly apiTokenId: string;
    readonly agentName: string;
    readonly args: Record<string, unknown>;
    readonly now: number;
  },
): Promise<{ readonly token: string; readonly expiresAt: number }> {
  const token = randomToken();
  const expiresAt = input.now + DRAWIO_LINK_TTL_MS;
  await db.batch([
    db
      .prepare("DELETE FROM drawio_link_tokens WHERE expires_at < ?1")
      .bind(input.now),
    db
      .prepare(
        `INSERT INTO drawio_link_tokens
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
export async function claimDrawioLink(
  db: D1Database,
  input: {
    readonly token: string;
    readonly kind: "upload" | "download";
    readonly now: number;
  },
): Promise<DrawioLinkClaim | null> {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.token)) return null;
  const hash = await sha256Hex(input.token);
  const toolMatch =
    input.kind === "download"
      ? "tool = 'download'"
      : "tool IN ('create_drawio', 'update_drawio')";
  const row = await db
    .prepare(
      `UPDATE drawio_link_tokens SET used_at = ?2
       WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2 AND ${toolMatch}
         AND EXISTS (SELECT 1 FROM api_tokens t
                     WHERE t.id = drawio_link_tokens.api_token_id AND t.revoked_at IS NULL)
       RETURNING tool, user_id, api_token_id, agent_name, args_json`,
    )
    .bind(hash, input.now)
    .first<{
      tool: DrawioLinkTool;
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
      await db
        .prepare("UPDATE drawio_link_tokens SET used_at = NULL WHERE token_hash = ?1")
        .bind(hash)
        .run();
    },
  };
}
