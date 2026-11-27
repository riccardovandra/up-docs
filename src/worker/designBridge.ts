// The agent bridge to an open design editor, without the Durable Object
// around it (designRoom.ts), so it runs in tests. Owner: S3.
//
// The open editor (the OpenPencil fork, src/app/automation/bridge/server.ts)
// holds one WebSocket to its design's room. It sends `{type:'register', token}`
// once, then answers each `{type:'request', id, command, args}` with
// `{type:'response', id, ok, result | error}`. The room sends
// `{type:'cancel', id}` for a request it stopped waiting for. The newest
// editor socket wins: an older one is closed with 1000, which the editor
// takes as final (it reconnects after any other close).
//
// The socket's only credential is a one-use ticket, issued to the design page
// (session, editor role) and spent by the handshake. Tickets live in the
// room's storage, so they outlast the room going to sleep.

/** How long a ticket waits for its handshake. The design page asks for a new one on reconnect. */
export const DESIGN_TICKET_TTL_MS = 60_000;
/** How long a command waits for the editor's answer before it is cancelled. */
export const DESIGN_COMMAND_TIMEOUT_MS = 20_000;
/** Unspent tickets one room keeps; the oldest go first. */
export const MAX_DESIGN_TICKETS = 20;

/** What the room forwards to the editor. `eval` and the editor's file commands never are. */
export const DESIGN_BRIDGE_COMMANDS = ["tool", "undo", "redo", "export", "selection"] as const;
export type DesignBridgeCommand = (typeof DESIGN_BRIDGE_COMMANDS)[number];
export const isDesignBridgeCommand = (value: string): value is DesignBridgeCommand =>
  (DESIGN_BRIDGE_COMMANDS as ReadonlyArray<string>).includes(value);

/** A ticket is 32 random bytes, hex. */
const TICKET = /^[0-9a-f]{64}$/;
export const isDesignTicket = (value: string) => TICKET.test(value);

/** The editor's answer to one command, or why there is none. */
export type DesignBridgeAnswer =
  | { readonly kind: "answer"; readonly ok: true; readonly result: unknown; readonly editor: string }
  | { readonly kind: "answer"; readonly ok: false; readonly error: string; readonly editor: string }
  /** No editor has this design open. */
  | { readonly kind: "not_open" }
  /** The editor did not answer within DESIGN_COMMAND_TIMEOUT_MS; the call was cancelled. */
  | { readonly kind: "timeout" }
  /** The editor's socket closed before it answered. */
  | { readonly kind: "closed" }
  /** A newer editor holds the socket than the one the caller expected; nothing was sent. */
  | { readonly kind: "editor_changed" }
  /** Not a command the room forwards. */
  | { readonly kind: "refused"; readonly error: string };

export interface BridgeSocket {
  send(data: string): void;
}

/** The open editor's socket, and which connection it is (a new one on every handshake). */
export interface BridgeEditor {
  readonly socket: BridgeSocket;
  readonly id: string;
}

interface Pending {
  readonly socket: BridgeSocket;
  readonly editor: string;
  readonly resolve: (answer: DesignBridgeAnswer) => void;
  readonly timer: unknown;
}

export interface DesignBridgeIo {
  /** The newest open editor connection, or null. */
  readonly editor: () => BridgeEditor | null;
  readonly setTimer: (run: () => void, ms: number) => unknown;
  readonly clearTimer: (timer: unknown) => void;
  readonly newId: () => string;
}

/** Requests in flight to the editor, matched to its answers by id. */
export class DesignBridge {
  private readonly pending = new Map<string, Pending>();
  private readonly io: DesignBridgeIo;

  constructor(io: DesignBridgeIo) {
    this.io = io;
  }

  get inFlight(): number {
    return this.pending.size;
  }

  command(
    command: string,
    args: unknown,
    /** Send only to this connection (from an earlier answer's `editor`). */
    expectedEditor?: string | null,
    timeoutMs = DESIGN_COMMAND_TIMEOUT_MS,
  ): Promise<DesignBridgeAnswer> {
    if (!isDesignBridgeCommand(command)) {
      return Promise.resolve({ kind: "refused", error: `"${command}" is not forwarded to the editor.` });
    }
    const editor = this.io.editor();
    if (!editor) return Promise.resolve({ kind: "not_open" });
    if (expectedEditor != null && editor.id !== expectedEditor) {
      return Promise.resolve({ kind: "editor_changed" });
    }
    const { socket } = editor;
    const id = this.io.newId();
    return new Promise<DesignBridgeAnswer>((resolve) => {
      const timer = this.io.setTimer(() => {
        if (!this.pending.delete(id)) return;
        try {
          socket.send(JSON.stringify({ type: "cancel", id }));
        } catch {
          // The socket is gone; nothing to cancel.
        }
        resolve({ kind: "timeout" });
      }, timeoutMs);
      this.pending.set(id, { socket, editor: editor.id, resolve, timer });
      try {
        socket.send(JSON.stringify({ type: "request", id, command, args: args ?? {} }));
      } catch {
        this.settle(id, { kind: "closed" });
      }
    });
  }

  /** A message from an editor socket: an answer to one of its requests, or nothing to act on. */
  receive(socket: BridgeSocket, data: unknown): void {
    if (typeof data !== "string") return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!parsed || typeof parsed !== "object") return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type !== "response" || typeof message.id !== "string") return;
    // Only the socket a request went to may answer it.
    const call = this.pending.get(message.id);
    if (call?.socket !== socket) return;
    this.settle(
      message.id,
      message.ok === true
        ? { kind: "answer", ok: true, result: message.result ?? null, editor: call.editor }
        : {
            kind: "answer",
            ok: false,
            editor: call.editor,
            error:
              typeof message.error === "string" && message.error
                ? message.error.slice(0, 2000)
                : "The editor refused the call.",
          },
    );
  }

  /** An editor socket closed: its unanswered requests end now. */
  dropped(socket: BridgeSocket): void {
    for (const [id, call] of [...this.pending]) {
      if (call.socket === socket) this.settle(id, { kind: "closed" });
    }
  }

  private settle(id: string, answer: DesignBridgeAnswer): void {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    this.io.clearTimer(call.timer);
    call.resolve(answer);
  }
}

/** What tickets need from the room's storage (a subset of DurableObjectStorage). */
export interface TicketStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string | string[]): Promise<boolean | number>;
  list<T>(options: { readonly prefix: string }): Promise<Map<string, T>>;
}

const TICKET_PREFIX = "ticket:";

function randomTicket(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Issues a ticket that expires in DESIGN_TICKET_TTL_MS, dropping spent-by-time ones. */
export async function issueDesignTicket(
  storage: TicketStorage,
  now: number,
): Promise<{ readonly ticket: string; readonly expiresAt: number }> {
  const kept = await storage.list<number>({ prefix: TICKET_PREFIX });
  const stale = [...kept].filter(([, expiresAt]) => expiresAt <= now).map(([key]) => key);
  const live = [...kept]
    .filter(([, expiresAt]) => expiresAt > now)
    .sort((a, b) => a[1] - b[1])
    .map(([key]) => key);
  const over = live.slice(0, Math.max(0, live.length - (MAX_DESIGN_TICKETS - 1)));
  if (stale.length + over.length > 0) await storage.delete([...stale, ...over]);
  const ticket = randomTicket();
  const expiresAt = now + DESIGN_TICKET_TTL_MS;
  await storage.put(TICKET_PREFIX + ticket, expiresAt);
  return { ticket, expiresAt };
}

/** Spends a ticket: true once for a ticket issued here and still in time, false after. */
export async function spendDesignTicket(
  storage: TicketStorage,
  ticket: string,
  now: number,
): Promise<boolean> {
  if (!isDesignTicket(ticket)) return false;
  const key = TICKET_PREFIX + ticket;
  const expiresAt = await storage.get<number>(key);
  if (expiresAt === undefined) return false;
  await storage.delete(key);
  return expiresAt > now;
}
