import { DurableObject } from "cloudflare:workers";

import type { SheetMeta, SheetRoomMessage } from "../shared/sheets.ts";
import type { Env } from "./env.ts";
import { joinPresence, leavePresence, receivePresence, type PresenceHost } from "./sheetPresence.ts";
import { SheetEngine, sheetAuthor, type SheetEditInput, type SheetEditResult } from "./sheets.ts";

/** Set by the Worker, never by the client: the stub is only reachable through it. */
export const SHEET_SOCKET_USER_HEADER = "X-Docs-User";

/**
 * One instance per sheet, addressed by sheet id. Every edit list and meta
 * change to the sheet runs here, one at a time (see `SheetEngine`), then is
 * pushed to the sheet's open pages over hibernating WebSockets. There is no
 * merge layer: an edit list on a stale `base` is refused.
 */
export class SheetRoom extends DurableObject<Env> {
  private engine: SheetEngine | null = null;
  private readonly presence: PresenceHost<WebSocket> = {
    sockets: () => this.ctx.getWebSockets(),
    userOf: (socket) => this.ctx.getTags(socket)[0] ?? null,
    nameOf: (userId) =>
      sheetAuthor(this.env.DB, { kind: "session", userId }).then(
        (author) => author.name,
        () => "",
      ),
    now: () => Date.now(),
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** The sheet id comes with every call: a Durable Object is not told the name it was addressed by. */
  private engineFor(sheetId: string): SheetEngine {
    if (this.engine?.sheetId === sheetId) return this.engine;
    this.engine = new SheetEngine(
      {
        db: this.env.DB,
        broadcast: (message) => this.broadcast(message),
        closeAll: (code, reason) => {
          for (const socket of this.ctx.getWebSockets()) {
            try {
              socket.close(code, reason);
            } catch {
              // Already closing.
            }
          }
        },
        now: () => Date.now(),
      },
      sheetId,
    );
    return this.engine;
  }

  private broadcast(message: SheetRoomMessage): void {
    const payload = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        // A socket closing mid-broadcast is cleaned up by the runtime.
      }
    }
  }

  async applyEdits(input: SheetEditInput & { readonly sheetId: string }): Promise<SheetEditResult> {
    const { sheetId, ...edit } = input;
    return this.engineFor(sheetId).applyEdits(edit);
  }

  async updateMeta(input: {
    readonly sheetId: string;
    readonly title?: string | undefined;
    readonly projectId?: string | null | undefined;
    readonly origin: string | null;
  }): Promise<SheetMeta> {
    const { sheetId, ...change } = input;
    return this.engineFor(sheetId).updateMeta(change);
  }

  async deleteSheet(input: { readonly sheetId: string; readonly origin: string | null }): Promise<void> {
    await this.engineFor(input.sheetId).deleteSheet({ origin: input.origin });
    this.engine = null;
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const userId = request.headers.get(SHEET_SOCKET_USER_HEADER);
    if (!userId) return new Response("Missing user", { status: 400 });
    const { 0: client, 1: server } = new WebSocketPair();
    // Tagged by user: presence takes the sender from the tag, never the message.
    this.ctx.acceptWebSocket(server, [userId]);
    await joinPresence(this.presence, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Presence only. Edits never arrive here: they come through the REST API,
   * where access is checked. See `sheetPresence.ts`.
   */
  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    await receivePresence(this.presence, socket, message);
  }

  override async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    leavePresence(this.presence, socket);
    // 1005, 1006 and 1015 describe a close and may not be sent in one.
    socket.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, "closing");
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    leavePresence(this.presence, socket);
  }
}

export function sheetRoom(env: Env, sheetId: string): DurableObjectStub<SheetRoom> {
  return env.SHEET_ROOM.get(env.SHEET_ROOM.idFromName(sheetId));
}
