// One Durable Object per design, addressed by design id: it holds the open
// editor's agent socket and forwards agent commands to it. Owner: S3. The
// protocol and the tickets are in designBridge.ts.

import { DurableObject } from "cloudflare:workers";

import {
  DesignBridge,
  issueDesignTicket,
  spendDesignTicket,
  type DesignBridgeAnswer,
} from "./designBridge.ts";
import type { Env } from "./env.ts";

const EDITOR_TAG = "editor";

interface EditorAttachment {
  /** Order of connection: the highest is the newest, the one commands go to. */
  readonly seq: number;
}

export class DesignRoom extends DurableObject<Env> {
  private readonly bridge = new DesignBridge({
    editor: () => this.editorSocket(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    newId: () => crypto.randomUUID(),
  });

  private sockets(): ReadonlyArray<{ socket: WebSocket; seq: number }> {
    return this.ctx
      .getWebSockets(EDITOR_TAG)
      .filter((socket) => socket.readyState === WebSocket.OPEN)
      .map((socket) => ({
        socket,
        seq: (socket.deserializeAttachment() as EditorAttachment | null)?.seq ?? 0,
      }));
  }

  private editorSocket(): WebSocket | null {
    let newest: { socket: WebSocket; seq: number } | null = null;
    for (const entry of this.sockets()) if (!newest || entry.seq > newest.seq) newest = entry;
    return newest?.socket ?? null;
  }

  /** A one-use ticket for the design page to hand the editor. */
  async issueTicket(): Promise<{ readonly ticket: string; readonly expiresAt: number }> {
    return issueDesignTicket(this.ctx.storage, Date.now());
  }

  async status(): Promise<{ readonly connected: boolean }> {
    return { connected: this.editorSocket() !== null };
  }

  async command(command: string, args: unknown): Promise<DesignBridgeAnswer> {
    return this.bridge.command(command, args);
  }

  /** The editor's socket handshake; the Worker checked its path, method and Origin. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const ticket = new URL(request.url).searchParams.get("ticket") ?? "";
    if (!(await spendDesignTicket(this.ctx.storage, ticket, Date.now()))) {
      return new Response("Ticket refused", { status: 403 });
    }
    const older = this.sockets();
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [EDITOR_TAG]);
    const seq = Math.max(Date.now(), ...older.map((entry) => entry.seq + 1));
    server.serializeAttachment({ seq } satisfies EditorAttachment);
    // The newest editor wins. 1000 tells the older one not to reconnect.
    for (const { socket } of older) {
      this.bridge.dropped(socket);
      try {
        socket.close(1000, "replaced by a newer editor");
      } catch {
        // Already closing.
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.bridge.receive(socket, message);
  }

  override async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    this.bridge.dropped(socket);
    // 1005, 1006 and 1015 describe a close and may not be sent in one.
    try {
      socket.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, "closing");
    } catch {
      // Already closed.
    }
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    this.bridge.dropped(socket);
  }
}

export function designRoom(env: Env, designId: string): DurableObjectStub<DesignRoom> {
  return env.DESIGN_ROOM.get(env.DESIGN_ROOM.idFromName(designId));
}
