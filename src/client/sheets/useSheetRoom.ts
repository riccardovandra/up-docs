import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { SHEET_SOCKET_CLOSE, type SheetRoomMessage } from "../../shared/sheets.ts";

const PING_INTERVAL_MS = 30_000;

/**
 * Listens to the sheet's room (`GET /api/sheets/:id/ws`). Edits go over REST;
 * the socket brings everyone's revisions, renames and the delete.
 *
 * Seam for live presence (S4): `send` writes one JSON message to the room
 * (dropped while the socket is down), and `onMessage` receives every message
 * the room sends, so presence types added to `SheetRoomMessage` arrive there.
 * `onReconnect` runs after a dropped socket comes back: what was broadcast
 * meanwhile is not replayed, so the page fetches the sheet again.
 */
export function useSheetRoom(
  sheetId: string,
  handlers: {
    readonly onMessage: (message: SheetRoomMessage) => void;
    readonly onReconnect: () => void;
    /** The room closed for good: the sheet was deleted or access was removed. */
    readonly onClosed?: (code: number) => void;
  },
): { readonly send: (message: unknown) => boolean } {
  const latest = useRef(handlers);
  const socketRef = useRef<WebSocket | null>(null);
  useLayoutEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    let socket: WebSocket | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let closed = false;

    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/api/sheets/${sheetId}/ws`);
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        if (attempts > 0) latest.current.onReconnect();
        attempts = 0;
        ping = setInterval(() => socket?.send("ping"), PING_INTERVAL_MS);
      });
      socket.addEventListener("message", (event) => {
        if (event.data === "pong") return;
        try {
          latest.current.onMessage(JSON.parse(String(event.data)) as SheetRoomMessage);
        } catch {
          // A message this page cannot read is skipped.
        }
      });
      socket.addEventListener("close", (event) => {
        if (ping) clearInterval(ping);
        if (socketRef.current === socket) socketRef.current = null;
        if (closed) return;
        if (event.code === SHEET_SOCKET_CLOSE.deleted || event.code === SHEET_SOCKET_CLOSE.accessRemoved) {
          latest.current.onClosed?.(event.code);
          return;
        }
        attempts += 1;
        retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempts));
      });
    };
    connect();

    return () => {
      closed = true;
      if (ping) clearInterval(ping);
      if (retry) clearTimeout(retry);
      socket?.close();
      socketRef.current = null;
    };
  }, [sheetId]);

  const send = useCallback((message: unknown) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  return { send };
}
