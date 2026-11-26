// Owner: S3 (agent tools). S2 left this stub: the design page asks it for the
// agent bridge's WebSocket address and passes the answer to the editor as
// `socketURL` in `up-designer:load`. Null means no agent bridge (S2's state).

/** The one-use agent socket address for the open design, or null when there is none. */
export async function getAgentSocketURL(designId: string): Promise<string | null> {
  void designId;
  return null;
}
