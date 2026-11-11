// Live presence in a sheet room: who has the sheet open and what they have
// selected. Kept apart from the Durable Object so it runs in tests: the room
// hands in its sockets, and each socket's state lives in its attachment, so a
// room woken from hibernation knows everyone without holding anything itself.

import {
  parseSheetClientMessage,
  presenceColorIndex,
  PRESENCE_EXPIRY_MS,
  type SheetPresence,
  type SheetRoomMessage,
} from "../shared/sheets.ts";

/** What presence needs of a hibernatable WebSocket. */
export interface PresenceSocket {
  send(message: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface PresenceHost<S extends PresenceSocket> {
  /** Every socket open on the room, the one in hand included. */
  sockets(): ReadonlyArray<S>;
  /** The user id the Worker tagged the socket with; never read from a message. */
  userOf(socket: S): string | null;
  /** The person's display name, "" when they have not set one. */
  nameOf(userId: string): Promise<string>;
  now(): number;
}

/** A page may send this many presence updates per window; the rest are dropped. */
export const PRESENCE_BURST = 10;
export const PRESENCE_WINDOW_MS = 1000;

interface Attachment {
  readonly presence: SheetPresence;
  /** When the room last heard from the page; older than `PRESENCE_EXPIRY_MS` is gone. */
  readonly seenAt: number;
  /** Flood control: when the current window started and how many updates it took. */
  readonly windowStart: number;
  readonly count: number;
}

function attachmentOf(socket: PresenceSocket): Attachment | null {
  try {
    const value = socket.deserializeAttachment() as Attachment | null | undefined;
    return value && typeof value === "object" && "presence" in value ? value : null;
  } catch {
    return null;
  }
}

function sendTo(socket: PresenceSocket, message: SheetRoomMessage): void {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // A socket closing mid-send is cleaned up by the runtime.
  }
}

const isLive = (attachment: Attachment, now: number) =>
  typeof attachment.seenAt === "number" && now - attachment.seenAt < PRESENCE_EXPIRY_MS;

/**
 * Drops every page the room has not heard from in time, as if it had closed.
 * Its socket may be dead without a close (an unload, a lost network), so the
 * runtime may never report it. A page that was only quiet and speaks again
 * joins afresh (see `receivePresence`).
 */
function sweepPresence<S extends PresenceSocket>(host: PresenceHost<S>, now: number): void {
  for (const socket of host.sockets()) {
    const attachment = attachmentOf(socket);
    if (attachment && !isLive(attachment, now)) leavePresence(host, socket);
  }
}

function relay<S extends PresenceSocket>(host: PresenceHost<S>, from: S, message: SheetRoomMessage): void {
  for (const socket of host.sockets()) {
    if (socket !== from && attachmentOf(socket)) sendTo(socket, message);
  }
}

/**
 * A socket opened: give it its presence, send it everyone already here, and
 * tell them it arrived. Returns false for a socket without a user tag.
 */
export async function joinPresence<S extends PresenceSocket>(host: PresenceHost<S>, socket: S): Promise<boolean> {
  const userId = host.userOf(socket);
  if (!userId) return false;
  const name = await host.nameOf(userId);
  const now = host.now();
  sweepPresence(host, now);
  const presence: SheetPresence = {
    connectionId: crypto.randomUUID(),
    userId,
    name,
    colorIndex: presenceColorIndex(userId),
    tabId: null,
    range: null,
    activeCell: null,
  };
  socket.serializeAttachment({ presence, seenAt: now, windowStart: 0, count: 0 } satisfies Attachment);
  const presences: SheetPresence[] = [];
  for (const other of host.sockets()) {
    const attachment = other === socket ? null : attachmentOf(other);
    if (attachment) presences.push(attachment.presence);
  }
  sendTo(socket, { type: "sheet.presence.snapshot", self: presence, presences });
  relay(host, socket, { type: "sheet.presence", ...presence });
  return true;
}

/** A message from a page: a presence update, relayed to everyone else. Anything else is dropped. */
export async function receivePresence<S extends PresenceSocket>(
  host: PresenceHost<S>,
  socket: S,
  text: string,
): Promise<void> {
  const message = parseSheetClientMessage(text);
  if (!message) return;
  const now = host.now();
  let attachment = attachmentOf(socket);
  if (attachment && !isLive(attachment, now)) {
    // Quiet past the expiry: the others are told it left, and it joins again below.
    leavePresence(host, socket);
    attachment = null;
  }
  if (!attachment) {
    // A socket opened before presence existed, one whose join never ran, or one that expired.
    if (!(await joinPresence(host, socket))) return;
    attachment = attachmentOf(socket);
    if (!attachment) return;
  }
  sweepPresence(host, now);
  // The identity is the one the socket joined with, from its tag.
  const current = attachment.presence;
  const fresh = now - attachment.windowStart >= PRESENCE_WINDOW_MS;
  const windowStart = fresh ? now : attachment.windowStart;
  const count = (fresh ? 0 : attachment.count) + 1;
  if (count > PRESENCE_BURST) {
    socket.serializeAttachment({ ...attachment, seenAt: now, windowStart, count } satisfies Attachment);
    return;
  }
  const presence: SheetPresence =
    message.type === "presence"
      ? { ...current, tabId: message.tabId, range: message.range, activeCell: message.activeCell }
      : { ...current, tabId: null, range: null, activeCell: null };
  socket.serializeAttachment({ presence, seenAt: now, windowStart, count } satisfies Attachment);
  relay(host, socket, { type: "sheet.presence", ...presence });
}

/** A socket closed or failed: tell everyone else, once. */
export function leavePresence<S extends PresenceSocket>(host: PresenceHost<S>, socket: S): void {
  const attachment = attachmentOf(socket);
  if (!attachment) return;
  try {
    socket.serializeAttachment(null);
  } catch {
    // Already gone; the others are still told.
  }
  relay(host, socket, { type: "sheet.presence.left", connectionId: attachment.presence.connectionId });
}
