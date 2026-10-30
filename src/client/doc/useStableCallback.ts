import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A function whose identity never changes but always calls the latest `fn`,
 * so memoised children (header, toolbar) skip re-rendering when the page does.
 */
export function useStableCallback<A extends ReadonlyArray<unknown>, R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: A) => latest.current(...args), []);
}
