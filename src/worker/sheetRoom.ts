import { DurableObject } from "cloudflare:workers";

import type { SheetMeta, SheetRoomMessage } from "../shared/sheets.ts";
import type { Env } from "./env.ts";
import { SheetEngine, type SheetEditInput, type SheetEditResult } from "./sheets.ts";

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
    // Tagged by user, for presence (S4) and for closing one person's sockets.
    this.ctx.acceptWebSocket(server, [userId]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * The presence seam. Edits never arrive here: they come through the REST API,
   * where access is checked. Today anything sent is dropped. Presence (S4)
   * parses a client message here, takes the sender from
   * `this.ctx.getTags(socket)[0]` (the user id the Worker set, never the
   * message), and relays it to the other sockets; per-socket state such as the
   * cursor goes in `socket.serializeAttachment` so it survives hibernation.
   */
  override async webSocketMessage(_socket: WebSocket, _message: string | ArrayBuffer): Promise<void> {}

  override async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    // 1005, 1006 and 1015 describe a close and may not be sent in one.
    socket.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, "closing");
  }
}

export function sheetRoom(env: Env, sheetId: string): DurableObjectStub<SheetRoom> {
  return env.SHEET_ROOM.get(env.SHEET_ROOM.idFromName(sheetId));
}
