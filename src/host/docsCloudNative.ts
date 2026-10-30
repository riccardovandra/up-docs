// Copied from t3code packages/shared/src/docsCloudNative.ts at 2ebefb19b7d0be19dc77bdfe5a8b1b8c8714e280.
/**
 * The mobile app's transport for the Docs Cloud embed protocol. The app loads
 * Docs Cloud as the top-level page of a WebView, so there is no parent window
 * to postMessage to. The messages are the same as in an iframe; only the
 * carrier differs.
 *
 * Page -> app: `window.ReactNativeWebView.postMessage(JSON.stringify(message))`.
 * The page's first message is `t3-docs:ready`, sent once it listens; the app
 * answers with hello, as a framing T3 Code does on iframe load.
 * App -> page: the app injects a script that dispatches a `t3-docs:host`
 * CustomEvent whose `detail` is the message. The script runs only while the
 * page is on the configured Docs Cloud origin. A CustomEvent cannot come from
 * another window, and the page listens for it only inside the app's WebView.
 */

export const NATIVE_HOST_EVENT = "t3-docs:host";
export const NATIVE_READY_TYPE = "t3-docs:ready";

/** The script the app injects to hand `message` to a Docs Cloud page at `origin`. */
export function nativeHostScript(origin: string, message: unknown): string {
  return (
    `if(location.origin===${JSON.stringify(origin)})` +
    `window.dispatchEvent(new CustomEvent(${JSON.stringify(NATIVE_HOST_EVENT)},` +
    `{detail:${JSON.stringify(message)}}));true;`
  );
}

/** A message the page posted to the app, or null when it is not JSON. */
export function parseNativeFrameMessage(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}
