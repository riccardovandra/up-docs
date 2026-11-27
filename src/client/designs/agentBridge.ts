// Owner: S3 (agent tools). The design page asks here for the agent bridge's
// WebSocket address and passes it to the editor: `socketURL` in
// `up-designer:load`, and `up-designer:connect {socketURL}` to reconnect.
//
// Each address holds a one-use ticket (src/worker/designAgent.ts). The editor
// reconnects to the same address after a drop, which a spent ticket refuses,
// so the page checks now and then whether an editor still holds the socket,
// and hands it a fresh address when none does. It never takes the socket from
// another editor (`ifDisconnected`), so two open tabs do not fight over it.

/** How often an open editor's page checks the agent socket. */
export const AGENT_SOCKET_CHECK_MS = 15_000;

async function askTicket(
  designId: string,
  ifDisconnected: boolean,
): Promise<{ readonly connected: boolean; readonly socketURL?: string } | null> {
  try {
    const response = await fetch(`/api/designs/${encodeURIComponent(designId)}/agent-ticket`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ifDisconnected ? { ifDisconnected: true } : {}),
    });
    if (!response.ok) return null;
    return (await response.json()) as { connected: boolean; socketURL?: string };
  } catch {
    return null;
  }
}

/** The one-use agent socket address for the open design, or null when there is none. */
export async function getAgentSocketURL(designId: string): Promise<string | null> {
  return (await askTicket(designId, false))?.socketURL ?? null;
}

/**
 * Keeps the editor's agent socket up: every AGENT_SOCKET_CHECK_MS while the page
 * is visible, and when it becomes visible again, `send` gets a fresh address if
 * no editor holds the socket. Returns what stops it.
 */
export function keepAgentSocket(designId: string, send: (socketURL: string) => void): () => void {
  let stopped = false;
  let checking = false;
  const check = async () => {
    if (stopped || checking || document.visibilityState !== "visible") return;
    checking = true;
    try {
      const answer = await askTicket(designId, true);
      if (!stopped && answer && !answer.connected && answer.socketURL) send(answer.socketURL);
    } finally {
      checking = false;
    }
  };
  const timer = window.setInterval(() => void check(), AGENT_SOCKET_CHECK_MS);
  const onVisible = () => void check();
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    stopped = true;
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
