import { useEffect, useLayoutEffect, useRef } from "react";

import type { RoomMessage } from "../../shared/protocol.ts";

const PING_INTERVAL_MS = 30_000;

/**
 * Listens to the doc's DocRoom. `onReconnect` runs after a dropped socket comes
 * back, since messages sent while disconnected are not replayed.
 */
export function useDocRoom(
  docId: string,
  handlers: {
    readonly onMessage: (message: RoomMessage) => void;
    readonly onReconnect: () => void;
  },
): void {
  const latest = useRef(handlers);
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
      socket = new WebSocket(`${protocol}//${window.location.host}/api/docs/${docId}/ws`);
      socket.addEventListener("open", () => {
        if (attempts > 0) latest.current.onReconnect();
        attempts = 0;
        ping = setInterval(() => socket?.send("ping"), PING_INTERVAL_MS);
      });
      socket.addEventListener("message", (event) => {
        if (event.data === "pong") return;
        latest.current.onMessage(JSON.parse(String(event.data)) as RoomMessage);
      });
      socket.addEventListener("close", (event) => {
        if (ping) clearInterval(ping);
        // 4403: access removed; 4404: doc deleted. Reconnecting cannot succeed.
        if (closed || event.code === 4403 || event.code === 4404) return;
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
    };
  }, [docId]);
}
