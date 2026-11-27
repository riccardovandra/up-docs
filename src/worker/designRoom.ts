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

export interface EditorAttachment {
  /** Order of connection: the highest is the newest, the one commands go to. */
  readonly seq: number;
  /** This connection, never reused: what a batch checks it still talks to. */
  readonly id: string;
}

/** A new connection's attachment: after every open one, and its own id. */
export function newEditorAttachment(
  openSeqs: ReadonlyArray<number>,
  now: number,
  newId: () => string = () => crypto.randomUUID(),
): EditorAttachment {
  return { seq: Math.max(now, ...openSeqs.map((seq) => seq + 1)), id: newId() };
}

export class DesignRoom extends DurableObject<Env> {
  private readonly bridge = new DesignBridge({
    editor: () => {
      const newest = this.newestEditor();
      return newest ? { socket: newest.socket, id: newest.id } : null;
    },
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    newId: () => crypto.randomUUID(),
  });

  private sockets(): ReadonlyArray<{ socket: WebSocket } & EditorAttachment> {
    return this.ctx
      .getWebSockets(EDITOR_TAG)
      .filter((socket) => socket.readyState === WebSocket.OPEN)
      .map((socket) => {
        const attachment = socket.deserializeAttachment() as EditorAttachment | null;
        return { socket, seq: attachment?.seq ?? 0, id: attachment?.id ?? "" };
      });
  }

  private newestEditor(): ({ socket: WebSocket } & EditorAttachment) | null {
    let newest: ({ socket: WebSocket } & EditorAttachment) | null = null;
    for (const entry of this.sockets()) if (!newest || entry.seq > newest.seq) newest = entry;
    return newest;
  }

  /** A one-use ticket for the design page to hand the editor. */
  async issueTicket(): Promise<{ readonly ticket: string; readonly expiresAt: number }> {
    return issueDesignTicket(this.ctx.storage, Date.now());
  }

  async status(): Promise<{ readonly connected: boolean }> {
    return { connected: this.newestEditor() !== null };
  }

  async command(
    command: string,
    args: unknown,
    expectedEditor?: string | null,
  ): Promise<DesignBridgeAnswer> {
    return this.bridge.command(command, args, expectedEditor);
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
    server.serializeAttachment(
      newEditorAttachment(
        older.map((entry) => entry.seq),
        Date.now(),
      ),
    );
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
